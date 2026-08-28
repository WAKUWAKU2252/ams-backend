import { and, count, desc, eq, getTableColumns, gt, inArray, isNull, ne, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '@intrastucture/db';
import {
  asset,
  assetRequest,
  assetRequestOpener,
  department,
  employee,
  purchaseOrder,
  purchaseOrderItem,
  user,
} from '@intrastucture/db/schema';
import { ConflictError, NotFoundError } from '@common/errors';
import { paginate } from '@common/pagination';
import { requireRow, requireScalar } from '@common/db-result';
import { isUniqueViolation } from '@common/pg-error';
import { APPROVER_ROLES } from '@common/roles';
import { COST_TOLERANCE, findSlotsByRequest } from '@modules/business/asset/asset.service';
// ชื่อคนในเอกสาร/Teams ใช้สูตรเดียวกับ dropdown เสมอ — ห้ามประกอบชื่อเองที่นี่
import { documentPersonName } from '@modules/business/master/master.service';
import { sendApprovalRequest } from '@modules/integrate/TEAMS/sendToManager';
import { sendToRequester } from '@modules/integrate/TEAMS/sendToRequester';
import * as poService from '@modules/business/purchase-order/purchase-order.service';
import { assetQrUrl, requestEditUrl } from '@common/app-url';
import * as presence from './presence.service';
import type { CreateDraftResult, ListQuery } from './asset-request.types';

const EDITABLE_STATUSES = ['DRAFT', 'REJECTED'] as const;
// ใบจบหน้าที่ที่ APPROVED (0014) — REGISTERED/CANCELLED ย้ายไปเป็นเรื่องของชิ้นแล้ว
// "รอบที่ยังเปิดค้าง" = ทุกสถานะที่ไม่ใช่ terminal ตรงกับ uq_asset_request_open_round
const TERMINAL_STATUSES = ['APPROVED'] as const;

function isEditableStatus(status: string): boolean {
  return (EDITABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * ด่านของทุกปุ่มในขั้นบัญชี: ต้องถือ lock ห้อง registration ของใบนั้นอยู่จริงถึงจะเขียนได้
 *
 * คู่กับ assertEditableBy ของฝั่งผู้ขอ (asset-request-line.service) แต่คนละห้อง — ใบเดียวกัน
 * ผู้ขอแก้ชิ้นที่ถูกตีกลับอยู่ห้อง draft ส่วนบัญชีออกเลขอยู่ห้อง registration จึงไม่บล็อกกันข้ามบทบาท
 *
 * ★ ถ้าไม่มีด่านนี้ สาย SSE จะเป็นแค่ป้ายบอกว่าใครใช้อยู่ ไม่ได้กันจริง — บัญชีคนที่สองที่
 *   เปิดหน้าค้างไว้ก่อน (หรือปิดสายไปแล้วแต่หน้ายังอยู่) ยังยิงทับได้ตามปกติ
 */
/**
 * ผู้ถือครองสำหรับใส่ในอีเมล — null = ของกลาง ซึ่งไม่ใช่ "ข้อมูลขาด"
 *
 * ต้องเขียนให้ต่างจากช่องที่ยังไม่ได้กรอก ไม่งั้นผู้ขออ่านแล้วนึกว่าลืมระบุแล้วไล่ตามแก้เปล่า ๆ
 * (ใช้ข้อความเดียวกับที่หน้าจอใช้ — ดู detailColumns ใน AssetRequestForm.vue)
 */
function ownerNameOf(employeeName: string | null): string {
  return employeeName?.trim() || 'ไม่ระบุ (ของกลาง)';
}

function assertRegistrationHolder(requestId: number, userId: number): void {
  if (!presence.isHolder('registration', requestId, userId)) {
    throw new ConflictError('ใบนี้กำลังถูกผู้อื่นแก้ไขอยู่ หรือหน้านี้ยังไม่ได้เปิดโหมดแก้ไข');
  }
}

export async function createDraft(poNumber: string, userId: number): Promise<CreateDraftResult> {
  const po = await db.query.purchaseOrder.findFirst({
    where: eq(purchaseOrder.poNumber, poNumber),
  });
  if (!po) throw new NotFoundError(`Purchase order ${poNumber}`);
  const activeWhere = and(
    eq(assetRequest.poNumber, poNumber),
    notInArray(assetRequest.status, [...TERMINAL_STATUSES]),
    isNull(assetRequest.deletedAt),
  );

  const existing = await db.query.assetRequest.findFirst({ where: activeWhere });
  if (existing) {
    return { requestId: existing.id, reused: true };
  }

  try {
    const inserted = requireRow(
      await db.insert(assetRequest).values({ poNumber, createdBy: userId }).returning(),
      `insert asset_request (PO ${poNumber})`,
    );
    return { requestId: inserted.id, reused: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await db.query.assetRequest.findFirst({ where: activeWhere });
      if (winner) return { requestId: winner.id, reused: true };
    }
    throw error;
  }
}
export async function getDraft(id: number, userId: number) {
  const request = await db.query.assetRequest.findFirst({
    where: and(eq(assetRequest.id, id), isNull(assetRequest.deletedAt)),
    with: {
      purchaseOrder: {
        with: {
          items: {
            orderBy: (item, { asc }) => [asc(item.poLine)],
            with: { grpoLines: { with: { grpo: true }, orderBy: (line, { asc }) => [asc(line.grpoId)] } },
          },
        },
      },
    },
  });
  if (!request) throw new NotFoundError(`Asset request ${id}`);
  await db
    .insert(assetRequestOpener)
    .values({ requestId: id, userId })
    .onConflictDoUpdate({
      target: [assetRequestOpener.requestId, assetRequestOpener.userId],
      set: { lastOpenedAt: sql`now()` },
    });

  // ── เติมแผนก/หัวหน้าของผู้ขอซื้อลงใน purchaseOrder ให้เลย
  //
  // สามอย่างนี้ (departmentId/departmentName/manager*) ไม่ได้อยู่บนแถว purchase_order —
  // ต้องไต่ ownerPrId → employee.departmentId → department → managerId เอา
  //
  // เดิมเส้นนี้คืนแถวดิบ แล้วหน้าจอต้องยิง GET /purchase-orders/:poNumber ซ้ำอีกรอบ
  // แล้วคัดลอกทีละช่องมายัดใส่เอง — ซึ่งพลาดมาแล้วจริง (ลืม departmentName ทั้งสองจุด
  // ค่าเลยเป็น undefined เงียบ ๆ ไม่มี error อะไรฟ้อง) คืนมาจากที่เดียวจึงไม่มีอะไรให้ลืม
  //
  // ชื่อ field ตรงกับที่ GET /purchase-orders/:poNumber คืน เพื่อให้ทั้งสองเส้นใช้ type เดียวกันได้
  const target = await poService.findApprovalTarget(request.purchaseOrder.ownerPrId);

  // lock ไม่อยู่ที่ DB แล้ว — สถานะ lock จริงมาจากสาย presence (registry in-memory) ที่ frontend เปิดเอง
  return {
    ...request,
    purchaseOrder: {
      ...request.purchaseOrder,
      departmentId: target.departmentId,
      departmentName: target.departmentName,
      managerId: target.managerEmployeeId,
      managerFirstName: target.managerFirstName,
      managerLastName: target.managerLastName,
      manageremail: target.managerEmail,
    },
  };
}

export async function listMyDrafts(userId: number, { page, limit, status }: ListQuery) {
  // ★ ใบที่บัญชีตีกลับ "รายชิ้น" ต้องโผล่ในลิสต์ด้วยเสมอ แม้ตัวกรองจะไม่มี APPROVED
  //
  // การตีกลับรายชิ้นไม่เปลี่ยนสถานะใบ (ใบยังเป็น APPROVED) — ตัวที่ถูกตีกลับคือ "ชิ้น"
  // หน้า Draft กรอง DRAFT/REJECTED อยู่ ใบพวกนี้จึงหายไปจากสายตาผู้ขอทั้งที่เป็นงานที่
  // รอเขาแก้อยู่ ผลคือวงจร "ตีกลับ → แก้ → กลับเข้าคิว" ตันตรงกลาง และบัญชีกด Submit
  // ไม่ได้ตลอดกาลเพราะชิ้นนั้นยังนับเป็นค้าง (asset.service.update เปิดให้แก้อยู่แล้ว
  // ด้วยเงื่อนไข status=APPROVED && rejectedAt != null — ขาดแค่ทางเข้าถึงใบ)
  const hasRejectedAsset = sql`exists (
    select 1 from ${asset}
    where ${asset.requestId} = ${assetRequest.id}
      and ${asset.rejectedAt} is not null and ${asset.deletedAt} is null
  )`;

  const conditions = [eq(assetRequestOpener.userId, userId), isNull(assetRequest.deletedAt)];
  if (status && status.length) {
    conditions.push(
      or(
        inArray(assetRequest.status, status),
        and(eq(assetRequest.status, 'APPROVED'), hasRejectedAsset)!,
      )!,
    );
  }
  const where = and(...conditions);

  const [rows, totalResult] = await Promise.all([
    db
      // createdBy เป็น id — join user มาแสดงชื่อในลิสต์ (createdBy คงไว้เป็น audit)
      .select({
        ...getTableColumns(assetRequest),
        createdByName: user.displayName,
        ownerPrName: purchaseOrder.ownerPrName,
        assetCount: sql<number>`(
          select count(*) from ${asset}
          where ${asset.requestId} = ${assetRequest.id} and ${asset.deletedAt} is null
        )::int`,
        /**
         * ชิ้นที่บัญชีตีกลับและ "ยังไม่ได้แก้" — 0 = แก้ครบแล้ว ไม่มีอะไรค้างฝั่งผู้ขอ
         *
         * นับจาก rejectedAt ที่ยังไม่ถูกล้าง (update() ล้างให้เองตอนผู้ขอแก้) จึงเป็นตัวเลข
         * ที่ลดลงเรื่อย ๆ ตามที่แก้ไป ไม่ใช่ยอดสะสม — บอกได้แค่ "เหลือกี่ชิ้น" ไม่ใช่
         * "แก้ไปแล้วกี่ชิ้น" เพราะระบบไม่ได้เก็บประวัติว่าเคยถูกตีกลับมาก่อน
         */
        rejectedAssetCount: sql<number>`(
          select count(*) from ${asset}
          where ${asset.requestId} = ${assetRequest.id}
            and ${asset.rejectedAt} is not null and ${asset.deletedAt} is null
        )::int`,
      })
      .from(assetRequest)
      .innerJoin(assetRequestOpener, eq(assetRequestOpener.requestId, assetRequest.id))
      .leftJoin(user, eq(user.id, assetRequest.createdBy))
        .innerJoin(purchaseOrder,eq(purchaseOrder.poNumber,assetRequest.poNumber))
      .where(where)
      .orderBy(desc(assetRequestOpener.lastOpenedAt))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ value: count() })
      .from(assetRequest)
      .innerJoin(assetRequestOpener, eq(assetRequestOpener.requestId, assetRequest.id))
      .where(where),
  ]);

  return paginate(rows, requireScalar(totalResult, 'count asset_request ของผู้ใช้'), page, limit);
}

// ── state machine: submit / approve / reject ──
// DRAFT/REJECTED ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED
//                                    └────────reject──────▶ REJECTED (แก้ต่อได้)

async function requireRequest(id: number) {
  const req = await db.query.assetRequest.findFirst({
    where: and(eq(assetRequest.id, id), isNull(assetRequest.deletedAt)),
  });
  if (!req) throw new NotFoundError(`Asset request ${id}`);
  return req;
}

// ── ลบ ──
// draft 1 ใบต่อ PO เป็นของกลางทั้งระบบ หน้า Draft ของแต่ละคนเป็นแค่ "หน้าต่างจัดการของตัวเอง"
// สิทธิ์เดียวที่ผู้ใช้มีจึงเป็นการเอาใบออกจากลิสต์ตัวเอง — ไม่มีใครลบใบของคนอื่นได้
// แม้แต่คนเปิดใบเอง (ใบร้างที่ไม่มีใครแตะจะถูกเก็บกวาดด้วย cleanup job ที่ดู updatedAt แทน)

/** เอาใบออกจากลิสต์ของตัวเอง — ไม่แตะข้อมูลคำขอเลย เปิดใบนั้นอีกครั้งก็กลับมาอยู่ในลิสต์ */
export async function leaveRequest(id: number, userId: number) {
  const deleted = await db
    .delete(assetRequestOpener)
    .where(and(eq(assetRequestOpener.requestId, id), eq(assetRequestOpener.userId, userId)))
    .returning();
  if (deleted.length === 0) throw new NotFoundError(`Asset request ${id} ในรายการของคุณ`);
  return { success: true };
}

// ── ด่านตรวจเนื้อหาก่อนส่ง ──
// DRAFT ตั้งใจให้ DB หลวม (ยอม NULL เกือบทั้งแผง) ความเข้มทั้งหมดจึงมาอยู่ตรงนี้จุดเดียว
// เข้มผิดชั้นเมื่อไร (ไปบังคับที่ DB) ระบบจะกรอกค้างไว้ระหว่างทางไม่ได้เลย
async function assertSubmittable(requestId: number, poNumber: string) {
  // ── ต้องมีของอย่างน้อย 1 ชิ้น — ด่านเดียวที่เหลือในระดับ "ชิ้น" ──────────────
  //
  // ⚠️ Serial number **ไม่บังคับ** (ตัดด่านออกแล้ว) — สินทรัพย์จำนวนมากไม่มีเลขเครื่องเลย
  // (โต๊ะ เก้าอี้ ตู้ งานติดตั้ง) คอลัมน์เป็น nullable อยู่แล้วทั้งที่ DB, createAssetBody
  // และฟอร์มฝั่งหน้าเว็บ — ด่านตรงนี้เป็นที่เดียวที่ยังบังคับ ทำให้ของกลุ่มนั้นส่งใบไม่ได้เลย
  //
  // สิ่งที่แลกไป (รู้ตัวไว้): S/N คือตัวเดียวที่แยก "ของสองชิ้นที่เหมือนกันทุกอย่าง" ออกจากกัน
  // ได้ก่อนที่บัญชีจะออกเลขสินทรัพย์ให้ ชิ้นที่ไม่มี S/N จึงอ้างอิงได้ด้วยเลข poLine.unitNo
  // เท่านั้นจนกว่าจะได้เลขจาก SAP — ถ้าวันหลังอยากบังคับกลับ ให้บังคับ "ตามหมวด"
  // (OITM.ItmsGrpCod / category) ไม่ใช่เปิดด่านนี้กลับมาทั้งระบบ
  const pieceCount = requireScalar(
    await db
      .select({ value: count() })
      .from(asset)
      .where(and(eq(asset.requestId, requestId), isNull(asset.deletedAt))),
    `นับชิ้นของคำขอ ${requestId}`,
  );
  if (pieceCount === 0) {
    throw new ConflictError('ยังไม่มีรายการสินทรัพย์ในคำขอนี้ — กรอกอย่างน้อย 1 ชิ้นก่อนส่ง');
  }

  // ยอดเงินรวมต่อบรรทัดห้ามเกินยอดใน PO เด็ดขาด — ทั้งบรรทัด (รวมงานเหมาที่แตกชิ้นเอง) แชร์งบ
  // ก้อนเดียวคือ lineTotal ถ้าเกินแปลว่ากระจายราคาผิด ต้องแก้ก่อนส่ง ไม่ใช่แค่หาเหตุผลมาอธิบาย
  //
  // ⚠️ ต้องรวม "ทุกรอบ" ไม่ใช่เฉพาะใบนี้ (แก้ใน 0014): PO เดียวรับของหลายรอบได้ ถ้านับแค่
  // ใบตัวเอง แต่ละรอบจะผ่านเพราะยอดตัวเองไม่เกิน แล้วยอดรวมจริงทะลุ lineTotal แบบเงียบ ๆ
  // (รอบ 1 ลง 5,000 / รอบ 2 ลง 5,000 บน lineTotal 8,000 → ผ่านทั้งคู่ รวมจริง 10,000)
  //
  // กัน CANCELLED ออกด้วย — ของที่บัญชีตัดทิ้งไม่ได้กินงบ ไม่งั้นรอบถัดไปจะถูกบล็อกด้วยยอด
  // ของที่ไม่มีอยู่จริง
  const costRows = await db
    .select({ poItemId: asset.poItemId, acquisitionCost: asset.acquisitionCost })
    .from(asset)
    .innerJoin(assetRequest, eq(assetRequest.id, asset.requestId))
    .where(
      and(
        eq(assetRequest.poNumber, poNumber),
        notInArray(asset.lifecycle, ['CANCELLED']),
        isNull(asset.deletedAt),
        isNull(assetRequest.deletedAt),
      ),
    );

  const items = await db
    .select({
      id: purchaseOrderItem.id,
      description: purchaseOrderItem.itemDescription,
      quantity: purchaseOrderItem.quantity,
      lineTotal: purchaseOrderItem.lineTotal,
    })
    .from(purchaseOrderItem)
    .where(eq(purchaseOrderItem.poNumber, poNumber));

  for (const item of items) {
    const sum = costRows
      .filter((r) => r.poItemId === item.id)
      // ?? 0: acquisitionCost เปิดให้ NULL ได้ตั้งแต่ 0010 เพื่อรับสินทรัพย์เก่าจาก SAP
      // ที่ไม่มีใบกำกับจึงไม่รู้ราคา — แถวที่มาถึงตรงนี้ผูกกับใบคำขอ (PO_FLOW) จึงมีราคา
      // เสมอตาม ck_asset_origin_chain นับ NULL เป็น 0 คือทางที่ปลอดภัยกว่าถ้าหลุดมาจริง
      // (ประเมินยอดต่ำไว้ก่อน = ไม่บล็อกการส่งใบคำขอด้วยตัวเลขที่เราเองก็ไม่รู้)
      .reduce((total, r) => total + (r.acquisitionCost ?? 0), 0);
    const lineAmount = item.lineTotal ?? 0;
    if (sum > lineAmount + COST_TOLERANCE) {
      throw new ConflictError(
        `"${item.description}" กรอกราคารวม ${sum.toLocaleString()} เกินยอดใน PO (${lineAmount.toLocaleString()}) ` +
          `— ลดราคารวมให้ไม่เกินยอด PO ก่อนส่ง`,
      );
    }
  }
}

/**
 * หาหัวหน้าที่ใบนี้จะถูกส่งไปหา — ต้องครบทุกช่องก่อนจะยอมให้ส่ง
 *
 * ด่านนี้อยู่ "ก่อน" การเปลี่ยนสถานะโดยตั้งใจ: เดิมสถานะเปลี่ยนเป็น PENDING_APPROVAL ไปแล้ว
 * ค่อยไปรู้ทีหลังตอนยิง Teams ว่าไม่มีหัวหน้า/ไม่มีอีเมล ซึ่งย้อนไม่ได้และส่งซ้ำก็ไม่ได้
 * (สถานะไม่ใช่ DRAFT/REJECTED แล้ว) ใบเลยค้างถาวรโดยไม่มีใครได้รับแจ้ง
 *
 * แยกข้อความตามช่องที่ขาด เพราะแต่ละกรณีต้องไปแก้คนละที่ — บอกรวม ๆ ว่า "ไม่พบหัวหน้า"
 * ผู้ใช้จะไม่รู้ว่าต้องไปตั้งหัวหน้าแผนก เติมอีเมล หรือสร้างบัญชีให้หัวหน้า
 */
async function resolveApprovalTarget(poNumber: string) {
  const po = await db.query.purchaseOrder.findFirst({
    columns: { ownerPrId: true, ownerPrName: true },
    where: eq(purchaseOrder.poNumber, poNumber),
  });
  if (!po?.ownerPrId) {
    throw new ConflictError(
      `PO ${poNumber} ไม่มีข้อมูลผู้ขอซื้อ (OwnerPR) จึงหาหัวหน้าผู้อนุมัติไม่ได้ `,
    );
  }

  const who = po.ownerPrName ?? `OwnerPR id ${po.ownerPrId}`;
  const target = await poService.findApprovalTarget(po.ownerPrId);

  if (!target.managerEmployeeId) {
    throw new ConflictError(`แผนกของ ${who} ยังไม่ได้ตั้งหัวหน้า ตั้งหัวหน้าแผนกก่อนจึงจะส่งคำขอได้`);
  }
  if (!target.managerEmail?.trim()) {
    throw new ConflictError(
      `หัวหน้าของ ${who} ยังไม่มีอีเมลในข้อมูลพนักงาน ระบบส่งเรื่องเข้า Teams ไม่ได้`,
    );
  }
  if (!target.managerUserId) {
    throw new ConflictError(
      `หัวหน้าของ ${who} ยังไม่มีบัญชีผู้ใช้ที่อนุมัติได้ใน AMS (ต้องมี user ที่ผูก employee คนนี้ เปิดใช้งานอยู่ และ role เป็น ${APPROVER_ROLES.join('/')})`,
    );
  }
  return target;
}

export async function submitRequest(id: number, expectedUpdatedAt: string, userId: number) {
  const req = await requireRequest(id);
  if (!isEditableStatus(req.status)) {
    throw new ConflictError('ส่งได้เฉพาะคำขอสถานะ DRAFT หรือ REJECTED เท่านั้น');
  }
  await assertSubmittable(req.id, req.poNumber);
  // ต้องผ่านด่านนี้ก่อน update — ล้มตรงนี้แปลว่าไม่มีอะไรเปลี่ยน ผู้ใช้แก้ข้อมูลแล้วกดใหม่ได้
  const target = await resolveApprovalTarget(req.poNumber);
  if (req.updatedAt !== expectedUpdatedAt) {
    throw new ConflictError('คำขอถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่');
  }

  const [row] = await db
    .update(assetRequest)
    .set({
      status: 'PENDING_APPROVAL',
      submittedAt: sql`now()`,
      // คนกดส่ง (RequestBy) — คนละคนกับ createdBy ได้ ใบเป็นของกลางต่อ PO
      submittedBy: userId,
      // snapshot หัวหน้า ณ ตอนส่ง ไม่ derive ทีหลัง: หัวหน้าแผนกเปลี่ยนได้ระหว่างรออนุมัติ
      // แล้วจะเทียบไม่ได้ว่าคนที่กดอนุมัติคือคนที่เราตั้งใจส่งไปหาจริงหรือเปล่า
      assignedManagerId: target.managerUserId,
      // ล้างร่องรอยการแจ้งของรอบก่อน — ใบที่ถูกตีกลับแล้วส่งใหม่ต้องเริ่มนับใหม่
      // ไม่งั้น notifyError เก่าจะค้างอยู่ทั้งที่รอบนี้ส่งผ่าน
      notifiedAt: null,
      notifyError: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(assetRequest.id, id), inArray(assetRequest.status, [...EDITABLE_STATUSES])))
    .returning({ id: assetRequest.id, status: assetRequest.status });
  if (!row) throw new ConflictError('คำขอเพิ่งถูกเปลี่ยนสถานะ กรุณาโหลดใหม่');

  // ยิงก่อน Teams โดยตั้งใจ — สถานะเปลี่ยนแล้วจริงตั้งแต่บรรทัดบน คนที่เปิดใบนี้ค้างอยู่
  // (อีกแท็บของเจ้าตัว/บัญชีที่กำลังดู) ควรเห็นทันที ไม่ต้องรอผลการยิงการ์ดซึ่งอาจ timeout
  presence.notifyStatus({ requestId: id, action: 'request-submitted', requestStatus: 'PENDING_APPROVAL', assetId: null, actorId: userId });

  // ── แจ้งเข้า Teams หลังสถานะเปลี่ยนแล้วเท่านั้น
  //
  // ลำดับนี้สำคัญ: การเปลี่ยนสถานะคือความจริง ส่วน Teams เป็นการแจ้งเตือน ยิงก่อนแล้ว
  // update ชนกับคนอื่น (409) = แจ้งไปแล้วว่ามีคำขอที่ไม่มีอยู่จริง
  //
  // และห้ามให้ Teams ล้มทำให้ทั้ง submit ล้ม — ใบถูกส่งไปแล้วจริง ผู้อนุมัติเปิดในระบบเห็นได้
  // อยู่ดี บอกให้รู้ว่าแจ้งไม่ผ่านก็พอ ไม่ใช่ทำให้ผู้ใช้คิดว่าส่งไม่สำเร็จแล้วกดซ้ำ (กดซ้ำไม่ได้ด้วย
  // เพราะสถานะไม่ใช่ DRAFT/REJECTED แล้ว)
  //
  // ⚠️ เดิมขั้นนี้อยู่ที่ frontend (DraftForm.notifyTeams) ซึ่งขาดกลางคันได้ — ปิดเบราว์เซอร์
  // ระหว่างสองขั้นแล้วใบค้าง PENDING_APPROVAL โดยไม่มีใครได้รับแจ้งและหาไม่เจอว่าใบไหน
  const notify = await notifyApprover(id, userId, target);
  return { ...row, notified: notify.ok, notifyError: notify.ok ? null : notify.message };
}

/**
 * ประกอบ payload จากข้อมูลในฐานข้อมูลแล้วยิงเข้า Teams — บันทึกผลลงใบเสมอ
 *
 * ประกอบที่นี่ไม่ใช่ที่ frontend เพราะข้อมูลทั้งหมด (serial/ราคา/สถานที่รายชิ้น/เลข GRPO)
 * มาจาก findSlotsByRequest อยู่แล้ว การให้ client ประกอบแปลว่าใครยิง endpoint เองก็ส่ง
 * ตัวเลขอะไรเข้าการ์ดก็ได้ และเราไม่มีทางรู้ว่าที่ผู้อนุมัติเห็นตรงกับในระบบไหม
 */
async function notifyApprover(
  requestId: number,
  submitterId: number,
  target: Awaited<ReturnType<typeof poService.findApprovalTarget>>,
): Promise<{ ok: boolean; message: string }> {
  try {
    const slots = await findSlotsByRequest(requestId);
    const [po] = await db
      .select({
        vendorName: purchaseOrder.vendorName,
        poDate: purchaseOrder.poDate,
        ownerPrName: purchaseOrder.ownerPrName,
      })
      .from(purchaseOrder)
      .where(eq(purchaseOrder.poNumber, slots.poNumber));

    // อีเมลของผู้ส่งคำขอมาด้วย — flow เอาไปใช้ตอนแจ้งผลกลับหลังหัวหน้ากด Approved
    // แหล่งอีเมลเดียวของระบบคือ employee.email (ไม่ใช่ user) จึง leftJoin เหมือนที่
    // confirmRegistration ทำ — leftJoin ไม่ใช่ innerJoin: user ที่ยังไม่ผูกพนักงานก็ต้อง
    // ส่งใบขออนุมัติได้ แค่ไม่มีปลายทางให้แจ้งผลเท่านั้น
    // ชื่อในเอกสาร/การ์ดต้องเป็น firstName + lastName ของพนักงาน ไม่ใช่ displayName ของบัญชี
    // (ดู documentPersonName) จึงดึงคอลัมน์ชื่อมาทั้งชุดพร้อมอีเมลในคิวรีเดียว
    const [submitter] = await db
      .select({
        displayName: user.displayName,
        email: employee.email,
        firstName: employee.firstName,
        lastName: employee.lastName,
        firstNameEn: employee.firstNameEn,
        lastNameEn: employee.lastNameEn,
        empId: employee.empId,
      })
      .from(user)
      .leftJoin(employee, eq(employee.id, user.employeeId))
      .where(eq(user.id, submitterId));
    const submitterName = documentPersonName(submitter);

    // ── เคยถูกตีกลับไหม
    //
    // submit ได้จาก DRAFT/REJECTED เท่านั้น และ submitRequest ไม่ล้าง rejectedAt/rejectReason ทิ้ง
    // (ตั้งใจ — เป็นประวัติของใบ) ดังนั้น "มี rejectedAt ตอนนี้" = รอบนี้คือการส่งใหม่หลังถูกตีกลับ
    // ไม่ต้องมีคอลัมน์นับรอบเพิ่ม
    // สองชั้น: rejectedBy ชี้ user แต่ชื่อที่ขึ้นการ์ดต้องมาจาก employee (firstName + lastName)
    const rejecter = alias(user, 'rejecter');
    const rejecterEmp = alias(employee, 'rejecter_emp');
    const [prev] = await db
      .select({
        rejectedAt: assetRequest.rejectedAt,
        rejectReason: assetRequest.rejectReason,
        rejectedRole: assetRequest.rejectedRole,
        displayName: rejecter.displayName,
        firstName: rejecterEmp.firstName,
        lastName: rejecterEmp.lastName,
        firstNameEn: rejecterEmp.firstNameEn,
        lastNameEn: rejecterEmp.lastNameEn,
        empId: rejecterEmp.empId,
      })
      .from(assetRequest)
      .leftJoin(rejecter, eq(rejecter.id, assetRequest.rejectedBy))
      .leftJoin(rejecterEmp, eq(rejecterEmp.id, rejecter.employeeId))
      .where(eq(assetRequest.id, requestId));

    const previousRejection = prev?.rejectedAt
      ? {
          at: prev.rejectedAt,
          by: documentPersonName(prev),
          role: prev.rejectedRole ?? '-',
          reason: prev.rejectReason ?? '-',
        }
      : null;

    const requestByEmail = submitter?.email?.trim() || null;
    if (!requestByEmail) {
      // ไม่ throw: การ์ดขออนุมัติต้องถึงหัวหน้าอยู่ดี — แต่ต้องมีร่องรอยว่าทำไมผู้ขอไม่ได้เมล
      console.warn(
        `⚠️ คำขอ ${requestId}: ผู้ส่งคำขอ (${submitterName}) ไม่มีอีเมลในข้อมูลพนักงาน — flow จะข้ามการแจ้งผลกลับหลังอนุมัติ`,
      );
    }

    // การ์ดจัดกลุ่มตาม "รอบรับของ" ไม่ใช่ตาม PO line — ผู้อนุมัติอ่านเป็นล็อตของที่มาถึง
    // ส่วน slots มาเป็น item → slot จึงต้องกลับด้านตรงนี้
    const byGrpo = new Map<string, Map<string, { poLine: string; description: string; serialItems: { serialNumber: string; pricePerUnit: number; location: string }[] }>>();
    for (const item of slots.items) {
      for (const slot of item.slots) {
        if (slot.status !== 'registered') continue;
        // ช่องของ PO line เดียวกันที่ถูกลงทะเบียนไว้ในใบก่อนก็อยู่ในรายการนี้ด้วย
        // (findSlotsByRequest นับข้ามใบ) — การ์ดต้องมีเฉพาะของที่ใบนี้ขออนุมัติจริง
        if (slot.requestId !== requestId) continue;
        const lines = byGrpo.get(slot.grpoNo) ?? new Map();
        byGrpo.set(slot.grpoNo, lines);
        const line = lines.get(item.poItemId) ?? {
          poLine: String(item.poLine),
          description: item.itemDescription,
          serialItems: [],
        };
        lines.set(item.poItemId, line);
        line.serialItems.push({
          serialNumber: slot.serialNumber ?? '-',
          pricePerUnit: slot.acquisitionCost,
          // "ที่ตั้ง - ตำแหน่งย่อย" — ไม่มีตำแหน่งย่อยก็เหลือแค่ชื่อที่ตั้ง (เหมือนที่ frontend เคยประกอบ)
          location: [slot.locationName, slot.subLocationName].filter(Boolean).join(' - ') || '-',
        });
      }
    }

    const result = await sendApprovalRequest({
      requestId,
      managerId: target.managerEmployeeId!,
      managerName: documentPersonName({
        firstName: target.managerFirstName,
        lastName: target.managerLastName,
        firstNameEn: target.managerFirstNameEn,
        lastNameEn: target.managerLastNameEn,
        empId: target.managerEmpId,
      }),
      managerEmail: target.managerEmail!,
      ownerPrName: po?.ownerPrName ?? '-',
      requestBy: submitterName,
      requestByEmail,
      previousRejection,
      poNumber: slots.poNumber,
      vendorName: po?.vendorName ?? '-',
      poDate: po?.poDate ?? '-',
      grpo: [...byGrpo].map(([grpoNumber, lines]) => ({
        grpoNumber,
        item: [...lines.values()].map((l) => ({ ...l, quantity: l.serialItems.length })),
      })),
    });

    await db
      .update(assetRequest)
      .set(
        result.ok
          ? { notifiedAt: sql`now()`, notifyError: null }
          : { notifyError: result.message.slice(0, 500) },
      )
      .where(eq(assetRequest.id, requestId));
    return { ok: result.ok, message: result.message };
  } catch (error) {
    // ประกอบ payload พังเอง (ข้อมูลไม่ครบ) ก็ต้องบันทึกไว้เหมือนกัน — ไม่งั้นใบจะดูเหมือน
    // "ส่งแล้วรอแจ้ง" ตลอดกาลโดยไม่มีใครรู้ว่าติดอะไร
    const message = error instanceof Error ? error.message : 'แจ้งเตือนเข้า Teams ไม่สำเร็จ';
    await db
      .update(assetRequest)
      .set({ notifyError: message.slice(0, 500) })
      .where(eq(assetRequest.id, requestId));
    return { ok: false, message };
  }
}

// approve — manager อนุมัติ (role กันที่ route ด้วย requireRole)
export async function approveRequest(id: number, managerId: number) {
  const req = await requireRequest(id);
  if (req.status !== 'PENDING_APPROVAL') {
    throw new ConflictError('อนุมัติได้เฉพาะคำขอที่รออนุมัติ');
  }
  const [row] = await db
    .update(assetRequest)
    .set({ status: 'APPROVED', approvedBy: managerId, approvedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(assetRequest.id, id), eq(assetRequest.status, 'PENDING_APPROVAL')))
    .returning({ id: assetRequest.id, status: assetRequest.status });
  if (!row) throw new ConflictError('คำขอเพิ่งถูกเปลี่ยนสถานะ');
  // ใบเพิ่งเข้าคิวบัญชี — หน้าคิวของบัญชีทุกคนต้องเห็นแถวใหม่เองโดยไม่ต้องกดรีเฟรช
  presence.notifyStatus({ requestId: id, action: 'request-approved', requestStatus: 'APPROVED', assetId: null, actorId: managerId });
  return row;
}

// ── ขั้นบัญชี: APPROVED ──ใส่เลขทีละชิ้น──▶ REGISTERED ─────────────────────
//
// หน่วยงานของ Finance คือ "ชิ้น" ไม่ใช่ "ใบ" — เลขสินทรัพย์ออกจาก SAP ทีละชิ้นและทยอยมา
// คนกรอกจึงต้องกรอกได้ทันทีที่ได้เลขมา ไม่ต้องรอให้ครบทั้ง PO
//
// ไม่มีปุ่ม "ปิดใบ" โดยตั้งใจ — สถานะของใบเป็นผลลัพธ์ที่ derive จากชิ้น ไม่ใช่สิ่งที่คนกด
// ถ้าให้กดปิดเองได้ จะเกิดใบ REGISTERED ที่ยังมีชิ้นค้าง แล้วชิ้นพวกนั้นหลุดจากคิว
// (คิวมองเฉพาะใบ APPROVED) กลายเป็นของที่ไม่มีใครเห็นและไม่มีทางลงทะเบียนต่อ
// ร้ายกว่านั้นคือ uq_asset_request_active ปล่อยให้เปิดใบใหม่ทับ PO เดิมได้ทันที
// แล้วประกาศจำนวนซ้ำจะได้ unitNo ตัวถัดไป = ของชิ้นเดียวแตกเป็นสองแถวโดยไม่มีอะไรฟ้อง

/**
 * คิวงานของบัญชี — "รายใบ" ไม่ใช่รายชิ้น
 *
 * หนึ่งแถว = หนึ่งใบที่อนุมัติแล้วและยังไม่ได้แจ้งผลกลับไปหาผู้ขอ หน้าจอกางดูรายชิ้น
 * ต่อด้วย GET /assets/slots/:requestId (เส้นเดียวกับหน้าลงทะเบียน) — ไม่ยัดรายชิ้นมาที่นี่
 * เพราะใบเดียวมีได้หลายสิบชิ้น และส่วนใหญ่ผู้ใช้กางดูทีละใบ
 *
 * เงื่อนไขคือ completeNotifiedAt IS NULL ไม่ใช่ "ยังมีชิ้นค้าง" — ใบที่กรอกเลขครบแล้วต้อง
 * ยังอยู่ในคิวจนกว่าบัญชีจะกดยืนยันส่งผลกลับ (ปุ่ม submit ที่ header) ถ้าเอาออกทันทีที่
 * เลขครบ ใบจะหายไปก่อนที่ใครจะได้กดยืนยัน
 *
 * ไม่ผูกกับ assetRequestOpener แบบ listMyDrafts เพราะบัญชีต้องเห็นใบที่ตัวเองไม่เคยแตะ
 * เรียงตามวันอนุมัติเก่า→ใหม่ ของที่รอนานที่สุดอยู่บนสุด
 */
/**
 * แถวคิวของบัญชี — คิวรีเดียวกันทั้งลิสต์และใบเดี่ยว ต่างกันแค่เงื่อนไข WHERE
 * แยกออกมาเพื่อไม่ให้สองที่นิยาม "ใบนี้เหลือกี่ชิ้น" คนละแบบแล้วปุ่มยืนยันในหน้าฟอร์ม
 * กับตัวเลขในตารางไม่ตรงกัน
 */
function pendingRegistrationQuery() {
  // นับรายชิ้นด้วย subquery ไม่ใช่ join+group — join จะทำให้แถวหัวซ้ำตามจำนวนชิ้น
  // แล้ว limit/offset ของ pagination นับผิด (ได้ 10 ชิ้น ไม่ใช่ 10 ใบ)
  const totalAssets = sql<number>`(
    select count(*) from ${asset}
    where ${asset.requestId} = ${assetRequest.id}
      and ${asset.lifecycle} <> 'CANCELLED' and ${asset.deletedAt} is null
  )::int`;
  // ★ สองตัวนี้ต้องแยกกัน ไม่ใช่ "DRAFT ทั้งหมด" ก้อนเดียว — ชิ้นที่ถูกตีกลับก็เป็น DRAFT
  // เหมือนกัน แต่คนละคนรออยู่: pending รอบัญชีออกเลข ส่วน rejected รอผู้ขอแก้
  // ถ้ารวมเป็นตัวเดียว ตารางจะขึ้น "เหลืออีก 2 ชิ้นที่ยังไม่มีเลข" ให้บัญชีอ่านทั้งที่งานนั้น
  // ไม่ได้อยู่ในมือบัญชีแล้ว และปุ่มยืนยันจะถูก disable ค้างจนกว่าผู้ขอจะแก้ (ซึ่งเป็นบั๊กที่
  // ทำให้เคส REJECTED ของ confirmRegistration ไปไม่ถึงปุ่มเลย)
  const pendingAssets = sql<number>`(
    select count(*) from ${asset}
    where ${asset.requestId} = ${assetRequest.id}
      and ${asset.lifecycle} = 'DRAFT' and ${asset.rejectedAt} is null and ${asset.deletedAt} is null
  )::int`;
  const rejectedAssets = sql<number>`(
    select count(*) from ${asset}
    where ${asset.requestId} = ${assetRequest.id}
      and ${asset.rejectedAt} is not null and ${asset.deletedAt} is null
  )::int`;
  // ชิ้นที่บัญชีตีกลับไปแล้วผู้ขอแก้กลับมา และยังไม่มีใครตรวจซ้ำ — "มีของใหม่รอคุณอยู่ในใบนี้"
  //
  // ★ ไม่ต้องกรอง lifecycle/rejectedAt เพิ่ม: rejectFixedAt ถูกล้างทุกครั้งที่บัญชีตัดสินชิ้นนั้น
  //   (assignAssetNumber / rejectAsset / cancelAsset ล้างทั้งสามที่) ค่านี้ไม่เป็น null จึงแปลว่า
  //   "แก้กลับมาแล้วและยังค้างรอบัญชี" อยู่ในตัว — ถ้าวันหลังมีใครเลิกล้างที่จุดใดจุดหนึ่ง
  //   ตัวเลขนี้จะค้างไม่ลด ซึ่งเป็นอาการที่มองเห็นได้ (จุดแดงไม่หาย) ไม่ใช่พังเงียบ
  const fixedAssets = sql<number>`(
    select count(*) from ${asset}
    where ${asset.requestId} = ${assetRequest.id}
      and ${asset.rejectFixedAt} is not null and ${asset.deletedAt} is null
  )::int`;

  const submitter = alias(user, 'submitter');
  const approver = alias(user, 'approver');
  // ชื่อที่คนอ่านต้องเป็นชื่อพนักงานจาก HR ไม่ใช่ displayName ของบัญชี (ดู documentPersonName)
  // จึงต้อง leftJoin employee ต่อจาก user อีกชั้น — leftJoin ทั้งคู่เพราะ user อาจยังไม่ผูกพนักงาน
  const submitterEmp = alias(employee, 'submitter_emp');
  const approverEmp = alias(employee, 'approver_emp');
  // ผู้ขอซื้อ (OwnerPR) — คนละคนกับผู้ส่งคำขอ จึงต้องเป็น alias ตัวที่สาม
  // ใช้ไต่ไปหาแผนก: purchase_order.ownerPrId → employee.departmentId → department.name
  const ownerEmp = alias(employee, 'owner_emp');

  return db
    .select({
      requestId: assetRequest.id,
      poNumber: assetRequest.poNumber,
      submittedAt: assetRequest.submittedAt,
      approvedAt: assetRequest.approvedAt,
      // ดิบทั้งชุด — ประกอบเป็นชื่อที่ withPersonNames() ทีเดียว ไม่ให้สองที่ประกอบคนละแบบ
      submittedBy: {
        displayName: submitter.displayName,
        firstName: submitterEmp.firstName,
        lastName: submitterEmp.lastName,
        firstNameEn: submitterEmp.firstNameEn,
        lastNameEn: submitterEmp.lastNameEn,
        empId: submitterEmp.empId,
      },
      approvedBy: {
        displayName: approver.displayName,
        firstName: approverEmp.firstName,
        lastName: approverEmp.lastName,
        firstNameEn: approverEmp.firstNameEn,
        lastNameEn: approverEmp.lastNameEn,
        empId: approverEmp.empId,
      },
      vendorName: purchaseOrder.vendorName,
      ownerPrName: purchaseOrder.ownerPrName,
      // แผนกของผู้ขอซื้อ — ไม่ได้อยู่บนแถว purchase_order ต้องไต่ผ่าน employee
      // leftJoin ทั้งสองชั้น: PO เก่าไม่มี ownerPrId / พนักงานบางคนยังไม่ผูกแผนก
      departmentName: department.name,
      // วันที่บน PO (จาก SAP) — nullable เพราะ PO เก่าบางใบไม่มีวันที่ในต้นทาง
      poDate: purchaseOrder.poDate,
      totalAssets,
      /** รอบัญชีตัดสิน (ยังไม่ออกเลข/ตีกลับ/ปิดถาวร) — 0 = กดปุ่มยืนยันได้แล้ว */
      pendingAssets,
      /** รอผู้ขอแก้ — > 0 แปลว่ากดปุ่มแล้วจะได้ผลลัพธ์ REJECTED ไม่ใช่ปิดงาน */
      rejectedAssets,
      /** ผู้ขอแก้ชิ้นที่ตีกลับกลับมาแล้ว รอบัญชีตรวจซ้ำ — หน้าคิวขึ้นจุดแดงเตือนที่ปุ่ม */
      fixedAssets,
    })
    .from(assetRequest)
    .innerJoin(purchaseOrder, eq(purchaseOrder.poNumber, assetRequest.poNumber))
    .leftJoin(submitter, eq(submitter.id, assetRequest.submittedBy))
    .leftJoin(submitterEmp, eq(submitterEmp.id, submitter.employeeId))
    .leftJoin(approver, eq(approver.id, assetRequest.approvedBy))
    .leftJoin(approverEmp, eq(approverEmp.id, approver.employeeId))
    .leftJoin(ownerEmp, eq(ownerEmp.id, purchaseOrder.ownerPrId))
    .leftJoin(department, eq(department.id, ownerEmp.departmentId));
}

type PendingRegistrationRaw = Awaited<ReturnType<typeof pendingRegistrationQuery>>[number];

/**
 * แปลงคอลัมน์ชื่อดิบเป็นชื่อที่หน้าจออ่าน — ชื่อพนักงานก่อน displayName เป็นทางหนีสุดท้าย
 *
 * คืน null (ไม่ใช่ '-') เมื่อยังไม่มีคนกดจริง เช่นใบที่ยังไม่ถูกอนุมัติ — '-' แปลว่า
 * "มีคนแต่ไม่รู้ชื่อ" ซึ่งคนละความหมายกับ "ยังไม่มีใครกด" และหน้าจอเลือกข้อความเองได้
 */
function withPersonNames({ submittedBy, approvedBy, ...row }: PendingRegistrationRaw) {
  return {
    ...row,
    submittedByName: submittedBy.displayName ? documentPersonName(submittedBy) : null,
    approvedByName: approvedBy.displayName ? documentPersonName(approvedBy) : null,
  };
}

const pendingRegistrationWhere = () =>
  and(
    eq(assetRequest.status, 'APPROVED'),
    isNull(assetRequest.completeNotifiedAt),
    isNull(assetRequest.deletedAt),
  );

export async function listPendingRegistration({ page, limit }: { page: number; limit: number }) {
  const where = pendingRegistrationWhere();

  const [rows, totalResult] = await Promise.all([
    pendingRegistrationQuery()
      .where(where)
      .orderBy(assetRequest.approvedAt, assetRequest.id)
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ value: count() }).from(assetRequest).where(where),
  ]);

  return paginate(
    rows.map(withPersonNames),
    requireScalar(totalResult, 'count ใบที่รอออกเลข'),
    page,
    limit,
  );
}

/**
 * ใบเดียวของคิวบัญชี — หน้าฟอร์มออกเลขใช้โหลดหัวใบ (ผู้ส่ง/ผู้อนุมัติ/จำนวนชิ้น)
 *
 * ไม่ใช้ getDraft ที่มีอยู่แล้วโดยตั้งใจ: อันนั้นบันทึก assetRequestOpener ให้คนที่เปิดด้วย
 * ซึ่งจะทำให้ใบไปโผล่ในลิสต์ "คำขอของฉัน" ของบัญชี ทั้งที่บัญชีไม่ได้เป็นผู้ขอ
 *
 * 404 ถ้าใบไม่อยู่ในคิวแล้ว (ยืนยันไปแล้ว/ถูกลบ) — หน้าฟอร์มเอาไปเด้งกลับหน้าคิวได้ตรง ๆ
 * แทนที่จะโชว์ฟอร์มเปล่าที่กดอะไรก็ 409
 */
export async function getPendingRegistration(requestId: number) {
  const [row] = await pendingRegistrationQuery().where(
    and(pendingRegistrationWhere(), eq(assetRequest.id, requestId)),
  );
  if (!row) throw new NotFoundError(`ใบคำขอ ${requestId} ที่รอออกเลข`);
  return withPersonNames(row);
}

/**
 * ใส่เลขสินทรัพย์ให้ชิ้นหนึ่ง แล้วปิดใบให้เองถ้าเป็นชิ้นสุดท้าย
 *
 * ── เลขซ้ำทำยังไง
 * ไม่ merge อัตโนมัติ ปฏิเสธพร้อมบอกว่าชนกับแถวไหน แล้วให้บัญชีตัดสินเอง — เพราะ
 * "เลขเดียวกัน" อาจแปลว่าของชิ้นเดียวกันที่ sync ดึงมาก่อน หรือแปลว่ากรอกผิด ซึ่งระบบ
 * แยกสองอย่างนี้ไม่ออก และคนที่ออกเลขคือคนเดียวที่รู้ว่าอันไหนเป็นอันไหน
 *
 * ทางออกมีอยู่แล้วโดยไม่ต้องมี merge: uq_asset_number เป็น partial index (WHERE deletedAt
 * IS NULL) บัญชีลบแถวที่ซ้ำทิ้ง เลขก็ว่าง และ connector เคารพการลบ (ไม่ปลุกกลับมา)
 *
 * ── ทำไมต้องล็อกแถวใบคำขอ
 * ขั้นตอนคือ "อัปเดตชิ้น แล้วนับว่าเหลือชิ้นที่ยังไม่มีเลขไหม" ถ้าสองคนกรอกสองชิ้นสุดท้าย
 * พร้อมกัน ต่างคนต่างมองไม่เห็นการอัปเดตของอีกฝ่าย (READ COMMITTED) แล้วจะสรุปว่า
 * "ยังเหลืออยู่" ทั้งคู่ — ใบค้าง APPROVED ตลอดกาลทั้งที่ทุกชิ้นมีเลขครบแล้ว
 */
export async function assignAssetNumber(
  requestId: number,
  assetId: number,
  assetNumber: string,
  userId: number,
) {
  // เช็คก่อนเปิด transaction — เป็นการอ่าน Map ใน RAM ไม่มีเหตุให้ไปถือ row lock ระหว่างเช็ค
  assertRegistrationHolder(requestId, userId);
  const result = await db.transaction(async (tx) => {
    // ล็อกก่อนอ่านอะไรทั้งนั้น — ทำให้การกรอกของใบเดียวกันเรียงคิวกัน (ดูเหตุผลข้างบน)
    const [req] = await tx
      .select({
        id: assetRequest.id,
        status: assetRequest.status,
        completeNotifiedAt: assetRequest.completeNotifiedAt,
      })
      .from(assetRequest)
      .where(and(eq(assetRequest.id, requestId), isNull(assetRequest.deletedAt)))
      .for('update');
    if (!req) throw new NotFoundError(`Asset request ${requestId}`);
    if (req.status !== 'APPROVED') {
      throw new ConflictError('ออกเลขได้เฉพาะคำขอที่อนุมัติแล้ว');
    }

    const [target] = await tx
      .select({
        id: asset.id,
        lifecycle: asset.lifecycle,
        assetNumber: asset.assetNumber,
        rejectedAt: asset.rejectedAt,
        // ใช้ประกอบ QR — บริษัทต้องมาจากตัวชิ้นเอง ไม่ใช่จาก scope ของคนที่กดออกเลข
        // (บัญชีกลางเห็นหลายบริษัท ถ้าเอาจาก scope จะได้ตัวแรกในลิสต์ซึ่งผิดได้)
        companyCode: asset.companyCode,
      })
      .from(asset)
      .where(and(eq(asset.id, assetId), eq(asset.requestId, requestId), isNull(asset.deletedAt)));
    // เช็ค requestId ใน where ด้วย — กันคนยิง assetId ของใบอื่นเข้ามาผ่าน URL ของใบนี้
    if (!target) throw new NotFoundError(`Asset ${assetId} ในคำขอ ${requestId}`);
    if (target.lifecycle === 'CANCELLED') {
      throw new ConflictError('สินทรัพย์ชิ้นนี้ถูกปิดถาวรไปแล้ว — ปลดการปิดก่อนจึงจะออกเลขได้');
    }
    // ── ออกเลขทับของเดิมได้ "จนกว่าจะกด Submit แจ้งผลกลับผู้ขอ"
    //
    // บัญชีพิมพ์เลขผิดได้ และรู้ตัวตอนไล่ตรวจทั้งใบก่อนกดยืนยัน — ล็อกตั้งแต่กรอกเสร็จทีละชิ้น
    // แปลว่าพิมพ์ผิดตัวเดียวต้องไปแก้ที่ DB เอง
    //
    // เส้นตายคือ completeNotifiedAt ไม่ใช่ lifecycle: หลังแจ้งผลไปแล้ว เลขชุดนั้นออกไปอยู่ใน
    // อีเมลของผู้ขอ (และถูกเอาไปติดป้าย/ตรวจรับ) แก้ฝั่งเราอย่างเดียวจะไม่ตรงกับที่เขาถืออยู่
    if (target.lifecycle === 'REGISTERED' && req.completeNotifiedAt) {
      throw new ConflictError(
        `คำขอนี้แจ้งผลกลับผู้ขอไปแล้ว แก้เลขสินทรัพย์ (${target.assetNumber}) ไม่ได้ — ต้องแก้ที่ SAP และแจ้งผู้ขอเอง`,
      );
    }
    // ชิ้นที่ตัวเองตีกลับไว้ ออกเลขทับไม่ได้ — ต้องรอผู้ขอแก้ก่อน (การแก้จะล้างสถานะตีกลับให้เอง)
    // ไม่ดักตรงนี้ = บัญชีตีกลับแล้วเผลอกดออกเลขต่อ ของที่ข้อมูลผิดจะเข้าทะเบียน SAP ไปเลย
    if (target.rejectedAt) {
      throw new ConflictError(
        'สินทรัพย์ชิ้นนี้ถูกตีกลับอยู่ ออกเลขไม่ได้จนกว่าผู้ขอจะแก้ข้อมูลแล้วส่งกลับ',
      );
    }

    // ── ด่านเลขซ้ำ: บอกให้พอทำงานต่อได้ ไม่ใช่แค่ "ซ้ำ"
    // ปล่อยให้ unique index จับเองก็ได้ แต่ error ของ pg บอกแค่ชื่อ constraint
    // ซึ่งไม่พอให้บัญชีตัดสินว่าควรลบแถวไหนหรือกรอกเลขใหม่
    const [clash] = await tx
      .select({
        id: asset.id,
        origin: asset.origin,
        description: asset.description,
        acquisitionDate: asset.acquisitionDate,
      })
      .from(asset)
      // ไม่นับตัวเอง — แก้เลขชิ้นเดิมโดยส่งเลขเดิมกลับมา (หรือกดซ้ำ) ต้องไม่ฟ้องว่าชนกับตัวเอง
      .where(
        and(
          eq(asset.assetNumber, assetNumber),
          // ★ ต้องจำกัดที่บริษัทเดียวกัน — uq_asset_number เป็น (companyCode, assetNumber)
          //   แล้วตั้งแต่ 0021 เลขเดียวกันคนละบริษัทไม่ถือว่าชน (มีจริง 24 คู่)
          eq(asset.companyCode, target.companyCode),
          ne(asset.id, assetId),
          isNull(asset.deletedAt),
        ),
      );
    if (clash) {
      const from = clash.origin === 'SAP_LEGACY' ? 'ดึงมาจาก SAP' : 'ลงทะเบียนผ่าน AMS';
      throw new ConflictError(
        `เลข ${assetNumber} ถูกใช้แล้วโดยสินทรัพย์ id ${clash.id} (${from}) ` +
          `"${clash.description ?? '-'}" วันที่ได้มา ${clash.acquisitionDate ?? '-'} — ` +
          `ถ้าเป็นของชิ้นเดียวกัน ให้ลบแถวนั้นก่อนแล้วกรอกใหม่`,
      );
    }

    const [updated] = await tx
      .update(asset)
      .set({
        assetNumber,
        // ได้เลข = อยู่ในทะเบียนของ SAP แล้วโดยนิยาม
        lifecycle: 'REGISTERED',
        // QR เกิดพร้อมเลข ไม่ใช่ตอนสร้างชิ้น — ก่อนมีเลขยังไม่มีอะไรให้สติกเกอร์ชี้ถึง
        // แก้เลขทับของเดิม = QR ต้องตามไปด้วย ไม่งั้นสติกเกอร์ที่พิมพ์รอบใหม่จะชี้เลขเก่า
        qrCode: assetQrUrl(target.companyCode, assetNumber),
        registeredAt: sql`now()`,
        registeredBy: userId,
        // ป้าย "แก้ไขแล้ว" หมดหน้าที่ตรงนี้ — งานรอบนั้นจบแล้ว ปล่อยค้างไว้ป้ายจะติดข้ามรอบ
        rejectFixedAt: null,
        updatedBy: userId,
        updatedAt: sql`now()`,
      })
      // ยอมทั้ง DRAFT (ออกเลขครั้งแรก) และ REGISTERED (แก้เลขก่อน Submit) — CANCELLED ถูกกันไปแล้ว
      // ข้างบน แต่ยังคงเงื่อนไข lifecycle ไว้ตรงนี้เพื่อกันคนอื่นเปลี่ยนสถานะแทรกระหว่างทาง
      .where(and(eq(asset.id, assetId), inArray(asset.lifecycle, ['DRAFT', 'REGISTERED'])))
      .returning({ id: asset.id, assetNumber: asset.assetNumber, lifecycle: asset.lifecycle });
    if (!updated) throw new ConflictError('สินทรัพย์ชิ้นนี้เพิ่งถูกเปลี่ยนสถานะ กรุณาโหลดใหม่');

    // ไม่มีการปิดใบอีกแล้ว (0014) — ใบจบหน้าที่ตั้งแต่ APPROVED สถานะของชิ้นอยู่ที่ชิ้น
    // คืน remaining ไว้ให้หน้าจอบอกได้ว่า "รอบนี้เหลืออีกกี่ชิ้น" เท่านั้น ไม่ได้เอาไปเปลี่ยน state
    const remaining = requireScalar(
      await tx
        .select({ value: count() })
        .from(asset)
        .where(
          and(eq(asset.requestId, requestId), eq(asset.lifecycle, 'DRAFT'), isNull(asset.deletedAt)),
        ),
      `นับชิ้นที่เหลือของคำขอ ${requestId}`,
    );

    return { asset: updated, remaining };
  });

  // ⚠️ นอก transaction โดยตั้งใจ — ยิงจากในนั้นแปลว่าคนที่ได้ event ไปโหลดใหม่ก่อน commit
  // แล้วเห็นชิ้นนี้ยังไม่มีเลข จอค้างของเก่าถาวรเพราะไม่มี event รอบสองมาแก้ให้
  presence.notifyStatus({ requestId, action: 'asset-numbered', requestStatus: 'APPROVED', assetId, actorId: userId });
  return result;
}

/**
 * บัญชีกด "ยืนยันและแจ้งกลับไปยังผู้ขอ" — ปุ่มเดียว ออกได้สองหน้า (0018)
 *
 *   ไม่มีชิ้นถูกตีกลับ → COMPLETE  ปิดงาน ใบหลุดออกจากคิว แจ้งเลขสินทรัพย์ให้ผู้ขอ
 *   มีชิ้นถูกตีกลับ    → REJECTED  ใบยังอยู่ในคิว แจ้งรายการที่ต้องแก้ให้ผู้ขอไปแก้
 *
 * ★ ทำไมการแจ้งตีกลับมาอยู่ที่ปุ่มนี้ ไม่ใช่ตอนกด rejectAsset: การตีกลับเป็นรายชิ้น ใบที่มี
 * 20 ชิ้นจะยิงอีเมล 20 ฉบับระหว่างที่บัญชีไล่ตรวจ ผู้ขอได้เมลรัวโดยที่ยังไม่มีรอบไหนจบ
 * — รวมมาแจ้งทีเดียวตอนบัญชีตรวจครบใบ ผู้ขอจึงได้ฉบับเดียวต่อรอบพร้อมรายการที่ต้องแก้ทั้งหมด
 *
 * ★ ด่านคือ "ทุกชิ้นถูกตัดสินแล้ว" ไม่ใช่ "ทุกชิ้นมีเลข": ชิ้นที่ถูกตีกลับถูก set กลับเป็น
 * lifecycle DRAFT + เลขว่าง ถ้าใช้เกณฑ์เดิม (นับ DRAFT ทั้งหมด) ใบที่มีชิ้นตีกลับจะกดปุ่ม
 * ไม่ได้ตลอดกาล — เคส REJECTED จะไปไม่ถึงปุ่มนี้เลย
 *
 * ★ เป็นการกดของมนุษย์ ไม่ใช่ derive จาก "เลขครบเมื่อไหร่" โดยตั้งใจ — บัญชีอาจกรอกเลข
 * ครบแล้วแต่ยังอยากตรวจอีกรอบก่อนส่งออก การยิงอีเมลอัตโนมัติทันทีที่ชิ้นสุดท้ายได้เลข
 * แปลว่าพิมพ์ผิดชิ้นสุดท้ายแล้วผู้ขอได้อีเมลผิดไปแล้วโดยแก้ไม่ทัน
 *
 * ผู้รับคือ submittedBy (คนกดส่งใบ) ไม่ใช่ ownerPr ของ PO — ใบเป็นของกลางต่อ PO ใครก็
 * เข้ามากรอกได้ คนที่ทำเรื่องและรอผลอยู่คือคนกดส่ง
 */
export async function confirmRegistration(requestId: number, userId: number) {
  assertRegistrationHolder(requestId, userId);
  const req = await requireRequest(requestId);
  if (req.status !== 'APPROVED') {
    throw new ConflictError('ยืนยันได้เฉพาะคำขอที่อนุมัติแล้ว');
  }
  if (req.completeNotifiedAt) {
    throw new ConflictError('คำขอนี้แจ้งผลกลับผู้ขอไปแล้ว');
  }

  // "ยังไม่ถูกตัดสิน" = ยังเป็น DRAFT และไม่ได้ถูกตีกลับ — คือชิ้นที่บัญชียังไม่แตะเลย
  // ชิ้นที่ตีกลับก็เป็น DRAFT เหมือนกันแต่ตัดสินไปแล้ว (รอผู้ขอ ไม่ได้รอบัญชี)
  const undecided = requireScalar(
    await db
      .select({ value: count() })
      .from(asset)
      .where(
        and(
          eq(asset.requestId, requestId),
          eq(asset.lifecycle, 'DRAFT'),
          isNull(asset.rejectedAt),
          isNull(asset.deletedAt),
        ),
      ),
    `นับชิ้นที่บัญชียังไม่ได้ตัดสินของคำขอ ${requestId}`,
  );
  if (undecided > 0) {
    throw new ConflictError(
      `ยังตัดสินไม่ครบ — เหลืออีก ${undecided} ชิ้นที่ยังไม่ได้ออกเลข ตีกลับ หรือปิดถาวร`,
    );
  }

  const slots = await findSlotsByRequest(requestId);
  // ของใบนี้เท่านั้น — findSlotsByRequest นับช่องข้ามใบ (PO เดียวเปิดคำขอได้หลายรอบ)
  // ผู้ขอไม่ควรได้อีเมลแจ้งของที่ตัวเองไม่ได้ขอรอบนี้
  const mine = slots.items.flatMap((item) =>
    item.slots
      .filter((s) => s.status === 'registered' && s.requestId === requestId)
      .map((s) => ({ item, slot: s as Extract<typeof s, { status: 'registered' }> })),
  );

  const registered = mine
    .filter(({ slot }) => slot.lifecycle === 'REGISTERED')
    .map(({ item, slot }) => ({
      // ผ่านด่าน undecided มาถึงตรงนี้ ชิ้น REGISTERED ต้องมีเลขเสมอ (ck_asset_registered_needs_number)
      assetNumber: slot.assetNumber ?? '-',
      description: item.itemDescription,
      serialNumber: slot.serialNumber ?? '-',
      location: [slot.locationName, slot.subLocationName].filter(Boolean).join(' - ') || '-',
      ownerName: ownerNameOf(slot.employeeName),
    }));

  const rejected = mine
    .filter(({ slot }) => slot.displayStatus === 'rejected')
    .map(({ item, slot }) => ({
      // ชิ้นที่ตีกลับยังไม่มีเลขสินทรัพย์ให้อ้าง ใช้เลขชิ้นที่คนอ่านบนหน้าจอแทน
      unitLabel: `${item.poLine}.${slot.unitNo}`,
      description: item.itemDescription,
      serialNumber: slot.serialNumber ?? '-',
      reason: slot.rejectReason ?? '-',
      ownerName: ownerNameOf(slot.employeeName),
    }));

  const cancelled = mine
    .filter(({ slot }) => slot.displayStatus === 'cancelled')
    .map(({ item, slot }) => ({
      unitLabel: `${item.poLine}.${slot.unitNo}`,
      description: item.itemDescription,
      reason: slot.cancelReason ?? '-',
      ownerName: ownerNameOf(slot.employeeName),
    }));

  const outcome = rejected.length > 0 ? 'REJECTED' : 'COMPLETE';

  // กดซ้ำทั้งที่ไม่มีอะไรเปลี่ยนตั้งแต่แจ้งรอบก่อน = ผู้ขอได้เมลซ้ำเนื้อหาเดิม ซึ่งเป็นอาการ
  // เดียวกับที่ flow นี้ตั้งใจจะเลิก — เทียบกับ asset.updatedAt เพราะทุกการตัดสินของบัญชี
  // และทุกการแก้ของผู้ขอแตะคอลัมน์นั้นหมด
  if (outcome === 'REJECTED' && req.rejectNotifiedAt) {
    const changed = requireScalar(
      await db
        .select({ value: count() })
        .from(asset)
        .where(
          and(
            eq(asset.requestId, requestId),
            isNull(asset.deletedAt),
            gt(asset.updatedAt, req.rejectNotifiedAt),
          ),
        ),
      `นับชิ้นที่เปลี่ยนหลังแจ้งรอบก่อนของคำขอ ${requestId}`,
    );
    if (changed === 0) {
      throw new ConflictError(
        'แจ้งรายการที่ต้องแก้ไปแล้วและยังไม่มีอะไรเปลี่ยนตั้งแต่รอบก่อน — รอผู้ขอแก้ก่อน',
      );
    }
  }

  // ผู้รับ: submittedBy -> user -> employee.email (แหล่งอีเมลเดียวของระบบตั้งแต่ 0005)
  // ชื่อที่ขึ้นหัวอีเมลต้องเป็น firstName + lastName ของพนักงาน ไม่ใช่ displayName (ดู documentPersonName)
  const [requester] = req.submittedBy
    ? await db
        .select({
          displayName: user.displayName,
          email: employee.email,
          firstName: employee.firstName,
          lastName: employee.lastName,
          firstNameEn: employee.firstNameEn,
          lastNameEn: employee.lastNameEn,
          empId: employee.empId,
        })
        .from(user)
        .leftJoin(employee, eq(employee.id, user.employeeId))
        .where(eq(user.id, req.submittedBy))
    : [];
  const requesterName = documentPersonName(requester);
  const email = requester?.email?.trim() ?? '';

  const [po] = await db
    .select({ vendorName: purchaseOrder.vendorName })
    .from(purchaseOrder)
    .where(eq(purchaseOrder.poNumber, req.poNumber));

  const common = {
    requestId,
    toRequester: email,
    requesterName,
    poNumber: req.poNumber,
    vendorName: po?.vendorName ?? '-',
    registered,
    cancelled,
  };

  // ── ไม่มีอีเมล ≠ ส่งไม่สำเร็จ
  // ไม่มีอีเมลคือ "ไม่มีอะไรให้ลองใหม่" — ข้อมูล HR ไม่มีให้ตั้งแต่แรก (ในกลุ่มผู้ขอ PO 64 คน
  // มี 28 คนที่ไม่มีอีเมลจากแหล่งไหนเลย ดู employee.email) ถ้าบล็อกไว้ ใบของคนกลุ่มนั้นจะ
  // ค้างคิวถาวร จึงบันทึกผลการตัดสินตามปกติแล้วคืน notified:false ให้หน้าจอเตือนว่าต้องแจ้งเอง
  //
  // ต่างจาก "ส่งแล้วล้ม" (Teams ล่ม/timeout) ซึ่งลองใหม่ได้ — อันนั้นต้องไม่ปิดใบ ไม่งั้น
  // บัญชีจะกดส่งซ้ำไม่ได้อีกเลย
  const send = email
    ? await sendToRequester(
        outcome === 'COMPLETE'
          ? { kind: 'COMPLETE', ...common }
          : { kind: 'REJECTED', ...common, rejected, editUrl: requestEditUrl(requestId) },
      )
    : null;

  const sendFailed = send !== null && !send.ok;
  const notifyError =
    send === null
      ? `ผู้ส่งคำขอ (${requesterName}) ไม่มีอีเมลในข้อมูลพนักงาน — ต้องแจ้งผลด้วยวิธีอื่นเอง`
      : send.ok
        ? null
        : send.message;

  // ส่งล้มแบบลองใหม่ได้ = ไม่ปิดอะไรทั้งนั้น เก็บแค่ error ไว้ให้กดซ้ำได้
  const closesRound = !sendFailed;
  const errorColumn = notifyError?.slice(0, 500) ?? null;

  if (outcome === 'COMPLETE') {
    await db
      .update(assetRequest)
      .set(
        closesRound
          ? {
              completeDate: sql`now()`,
              completedBy: userId,
              // ธงปิดงาน: ใบหลุดจากคิวบัญชีและห้ามแก้อะไรอีก — ตั้งแม้ไม่มีอีเมลให้ส่ง
              // เพราะ "ปิดงานแล้ว" กับ "อีเมลออกแล้ว" เป็นคนละเรื่อง (ตัวหลังอยู่ที่ notifyError)
              completeNotifiedAt: sql`now()`,
              completeNotifyError: errorColumn,
            }
          : { completeNotifyError: errorColumn },
      )
      .where(eq(assetRequest.id, requestId));
  } else {
    // ★ REJECTED ห้ามแตะ completeNotifiedAt — ใบต้องอยู่ในคิวบัญชีต่อ รอผู้ขอแก้แล้วออกเลขให้จบ
    await db
      .update(assetRequest)
      .set(
        closesRound
          ? { rejectNotifiedAt: sql`now()`, rejectNotifyError: errorColumn }
          : { rejectNotifyError: errorColumn },
      )
      .where(eq(assetRequest.id, requestId));
  }

  // ปุ่มนี้เปลี่ยนสองอย่างที่คนอื่นเห็นทันที: ใบหลุดจากคิวบัญชี (COMPLETE) หรือมีรายการที่
  // ผู้ขอต้องแก้ (REJECTED) — ผู้ขอที่เปิดใบค้างอยู่ต้องเห็นป้ายตีกลับโดยไม่ต้องรอเปิดเมล
  //
  // ยิงแม้ closesRound = false ด้วย: เมลส่งไม่ออกก็จริง แต่ rejectNotifyError ที่เพิ่งเขียนลงไป
  // เป็นสิ่งที่หน้าคิวควรเห็น และตัวเลขในตารางก็เปลี่ยนไปแล้วจากรอบตัดสินก่อนหน้านี้
  presence.notifyStatus({
    requestId,
    action: 'registration-confirmed',
    // ใบยัง APPROVED อยู่ทั้งสองทาง (ปุ่มนี้เซ็ต completeNotifiedAt/rejectNotifiedAt ไม่ได้
    // แตะ status) — ก้อนนี้จึงต้องถึงหน้าคิว เพราะเป็นตัวที่ทำให้แถวหลุดออกจากคิวไป
    requestStatus: 'APPROVED',
    assetId: null,
    actorId: userId,
  });

  return {
    requestId,
    outcome,
    /** จำนวนชิ้นที่ผู้ขอต้องกลับมาแก้ — 0 เมื่อ outcome = COMPLETE */
    rejectedCount: rejected.length,
    notified: send?.ok ?? false,
    notifyError,
    /** true = ล้มแบบลองใหม่ได้ (Teams ล่ม) กดซ้ำได้ / false = จบรอบแล้วแม้เมลจะไม่ออก */
    retryable: sendFailed,
  };
}

/**
 * บัญชีตัดชิ้นทิ้ง — ของที่รับมาแล้วแต่จะไม่ลงทะเบียน (นับเกิน/ส่งคืน/ชำรุด)
 *
 * เป็น lifecycle ไม่ใช่ soft delete โดยตั้งใจ: ต้องตอบย้อนหลังได้ว่าทำไมของที่รับมา 5 ชิ้น
 * ถึงลงทะเบียนแค่ 4 — ถ้าลบทิ้งจะไม่เหลืออะไรให้ตอบ (ดู enumAssetLifecycle)
 *
 * ช่องที่ถูกตัดทิ้งจะคืนให้ลงใหม่ได้ เพราะตัวนับใน asset.service กัน CANCELLED ออกแล้ว
 * — แต่ unitNo เดิมไม่ถูกใช้ซ้ำ (แถวยังอยู่จริงและยังกิน unique (poItemId, unitNo))
 */
export async function cancelAsset(
  requestId: number,
  assetId: number,
  reason: string,
  userId: number,
) {
  assertRegistrationHolder(requestId, userId);
  const req = await requireRequest(requestId);

  const [target] = await db
    .select({ id: asset.id, lifecycle: asset.lifecycle, assetNumber: asset.assetNumber })
    .from(asset)
    .where(and(eq(asset.id, assetId), eq(asset.requestId, requestId), isNull(asset.deletedAt)));
  if (!target) throw new NotFoundError(`Asset ${assetId} ในคำขอ ${requestId}`);
  // เส้นตายเดียวกับ assignAssetNumber/rejectAsset: ถอยกลับได้จนกว่าจะแจ้งผลกลับผู้ขอ
  if (target.lifecycle === 'REGISTERED' && req.completeNotifiedAt) {
    throw new ConflictError(
      `คำขอนี้แจ้งผลกลับผู้ขอไปแล้ว ปิดชิ้นที่ออกเลขแล้ว (${target.assetNumber}) ไม่ได้ — ` +
        `ของที่อยู่ในทะเบียน SAP แล้วต้องจัดการที่ SAP`,
    );
  }
  if (target.lifecycle === 'CANCELLED') throw new ConflictError('สินทรัพย์ชิ้นนี้ถูกยกเลิกไปแล้ว');

  const [row] = await db
    .update(asset)
    .set({
      lifecycle: 'CANCELLED',
      // ⚠️ ไม่ล้าง assetNumber ทิ้ง (ck_asset_registered_needs_number ห้ามแค่ "REGISTERED ต้องมีเลข"
      // ไม่ได้ห้าม CANCELLED ถือเลข) — ปิดถาวรเป็นคำสั่งที่ปลดได้ ถ้าล้างเลขตอนปิด พอปลดการปิด
      // จะได้ชิ้นเปล่าที่ต้องกรอกเลขใหม่ ทั้งที่ผู้ใช้แค่กดผิดปุ่มแล้วกดกลับ
      // เลขยังถูกจองไว้ในดัชนี unique ด้วย ซึ่งถูกแล้ว: ตราบใดที่ยังไม่ปลด ชิ้นนี้ยังเป็นเจ้าของเลขนั้น
      cancelReason: reason,
      cancelledAt: sql`now()`,
      cancelledBy: userId,
      // ล้างสถานะตีกลับทิ้ง — บัญชีเปลี่ยนใจจาก "ให้ไปแก้" เป็น "ไม่เอาแล้ว" คำสั่งหลังทับคำสั่งแรก
      // และ ck_asset_reject_only_draft บังคับอยู่แล้วว่า rejectedAt มีได้เฉพาะตอน lifecycle = DRAFT
      // ไม่ล้าง = update ตัวนี้ถูก constraint ปฏิเสธทั้งก้อน (ยกเลิกชิ้นที่ตีกลับไว้ไม่ได้เลย)
      rejectedAt: null,
      rejectedBy: null,
      rejectReason: null,
      rejectedRole: null,
      // ปิดถาวร = ไม่มีใครต้องตรวจชิ้นนี้อีก ป้าย "แก้ไขแล้ว" จึงหมดหน้าที่พร้อมกัน
      rejectFixedAt: null,
      updatedBy: userId,
      updatedAt: sql`now()`,
    })
    .where(and(eq(asset.id, assetId), inArray(asset.lifecycle, ['DRAFT', 'REGISTERED'])))
    .returning({ id: asset.id, lifecycle: asset.lifecycle });
  if (!row) throw new ConflictError('สินทรัพย์ชิ้นนี้เพิ่งถูกเปลี่ยนสถานะ กรุณาโหลดใหม่');

  presence.notifyStatus({ requestId, action: 'asset-cancelled', requestStatus: req.status, assetId, actorId: userId });
  return row;
}

/**
 * บัญชีตีกลับ "รายชิ้น" — ของมาถึงจริงและจะลงทะเบียน แต่ข้อมูลที่กรอกมาใช้ไม่ได้
 * (S/N ไม่ตรงกับตัวเครื่อง รูปไม่ชัด ที่ตั้งผิดตึก) ผู้ขอต้องกลับไปแก้แล้วส่งกลับเข้าคิว
 *
 * คนละอย่างกับสองปุ่มข้างเคียงโดยสิ้นเชิง — อย่าเอามารวมกัน:
 *   reject  ของยังอยู่ ข้อมูลผิด  -> แก้แล้วออกเลขต่อได้    (ปุ่มนี้)
 *   cancel  ของจะไม่ลงทะเบียน     -> ปิดถาวร ช่องไม่คืน
 *   number  ข้อมูลถูกต้อง          -> ออกเลข จบ
 *
 * ตีกลับได้เฉพาะตอนใบอยู่ APPROVED เท่านั้น: ก่อนหน้านั้นใบยังแก้ได้อยู่แล้ว การตีกลับรายชิ้น
 * จะซ้ำซ้อนกับการที่ผู้ใช้แก้เองได้ และหลังจากออกเลขไปแล้วก็ตีกลับไม่ได้ (ของอยู่ใน SAP แล้ว)
 *
 * ไม่แตะ asset_request.status โดยตั้งใจ — ชิ้นอื่นในใบเดียวกันต้องเดินหน้าออกเลขต่อได้ตามปกติ
 * ถ้าดึงทั้งใบกลับเป็น REJECTED เพราะชิ้นเดียว งานของ 19 ชิ้นที่เหลือจะหยุดไปด้วย
 */
export async function rejectAsset(
  requestId: number,
  assetId: number,
  reason: string,
  userId: number,
  role: string,
) {
  assertRegistrationHolder(requestId, userId);
  const req = await requireRequest(requestId);
  if (req.status !== 'APPROVED') {
    throw new ConflictError('ตีกลับรายชิ้นได้เฉพาะคำขอที่อนุมัติแล้ว (ขั้นออกเลขของบัญชี)');
  }

  const [target] = await db
    .select({
      id: asset.id,
      lifecycle: asset.lifecycle,
      assetNumber: asset.assetNumber,
      rejectedAt: asset.rejectedAt,
    })
    .from(asset)
    .where(and(eq(asset.id, assetId), eq(asset.requestId, requestId), isNull(asset.deletedAt)));
  // เช็ค requestId ด้วย — กันคนยิง assetId ของใบอื่นเข้ามาผ่าน URL ของใบนี้ (เหมือน assignAssetNumber)
  if (!target) throw new NotFoundError(`Asset ${assetId} ในคำขอ ${requestId}`);
  // ชิ้นที่ออกเลขไปแล้วยัง "ถอยกลับ" ได้จนกว่าจะกด Submit แจ้งผลกลับผู้ขอ — เส้นตายเดียวกับ
  // การแก้เลข (ดู assignAssetNumber) เพราะทั้งหมดนี้คือการแก้สิ่งที่บัญชีเพิ่งกรอกผิดในรอบเดียวกัน
  //
  // ⚠️ เลขที่เคยกรอกถูกล้างทิ้งด้วย: ck_asset_registered_needs_number บังคับให้ REGISTERED
  // ต้องมีเลข และชิ้นที่กลับไปเป็น DRAFT ต้องไม่ค้างเลขไว้ (ทั้งจองเลขนั้นไว้ในดัชนี unique
  // และทำให้ตัวนับ "เหลือกี่ชิ้นที่ยังไม่มีเลข" อ่านค่าขัดกับหน้าจอ)
  // ถ้าลงทะเบียนที่ SAP ไปแล้วจริง ต้องไปจัดการฝั่ง SAP เองด้วย — AMS ล้างได้แค่ฝั่งตัวเอง
  if (target.lifecycle === 'REGISTERED' && req.completeNotifiedAt) {
    throw new ConflictError(
      `คำขอนี้แจ้งผลกลับผู้ขอไปแล้ว ตีกลับชิ้นที่ออกเลขแล้ว (${target.assetNumber}) ไม่ได้ — ต้องจัดการที่ SAP และแจ้งผู้ขอเอง`,
    );
  }
  if (target.lifecycle === 'CANCELLED') {
    throw new ConflictError('สินทรัพย์ชิ้นนี้ถูกปิดถาวรไปแล้ว ตีกลับไม่ได้');
  }
  if (target.rejectedAt) {
    throw new ConflictError('สินทรัพย์ชิ้นนี้ถูกตีกลับอยู่แล้ว — รอผู้ขอแก้ไขก่อน');
  }

  const row = requireRow(
    await db
      .update(asset)
      .set({
        // กลับเป็น DRAFT + ล้างเลข — ck_asset_reject_only_draft ไม่ยอมให้ชิ้น REGISTERED
        // ถือ rejectedAt ไว้ได้อยู่แล้ว (ชิ้นที่เป็น DRAFT อยู่แล้วเซ็ตซ้ำก็ไม่เปลี่ยนอะไร)
        lifecycle: 'DRAFT',
        assetNumber: null,
        // QR ตายไปพร้อมเลข — สติกเกอร์ที่พิมพ์ไว้ชี้ไปที่เลขที่ไม่ใช่ของชิ้นนี้อีกต่อไป
        // ถ้าปล่อยค้างไว้ ดัชนี uq_asset_qr_code จะจองค่านั้นไว้ให้ชิ้นที่ไม่มีเลข แล้วชิ้นอื่น
        // ที่ได้เลขเดียวกันไปทีหลัง (เลขถูกคืนเข้าระบบแล้ว) จะออกเลขไม่ได้เพราะ QR ชนกัน
        qrCode: null,
        // ล้างคู่กับเลข — ชิ้นที่ไม่มีเลขแล้วต้องไม่ค้างว่า "ออกเลขโดยใคร" ไว้จากรอบก่อน
        registeredAt: null,
        registeredBy: null,
        rejectedAt: sql`now()`,
        rejectedBy: userId,
        rejectReason: reason,
        rejectedRole: role,
        // ตีกลับรอบใหม่ = ป้าย "แก้ไขแล้ว" ของรอบก่อนใช้ไม่ได้แล้ว (แก้มายังไม่ผ่านอยู่ดี)
        rejectFixedAt: null,
        updatedBy: userId,
        updatedAt: sql`now()`,
      })
      .where(and(eq(asset.id, assetId), inArray(asset.lifecycle, ['DRAFT', 'REGISTERED'])))
      .returning({ id: asset.id, rejectedAt: asset.rejectedAt, rejectReason: asset.rejectReason }),
    `reject asset ${assetId}`,
  );

  // ผู้ขอที่เปิดใบเดียวกันอยู่ (ห้อง draft) ได้ก้อนนี้ด้วย — เห็นป้าย Rejected กับเหตุผลทันที
  // ไม่ต้องรอเมลรอบ confirmRegistration ซึ่งอาจอีกครึ่งวัน
  presence.notifyStatus({ requestId, action: 'asset-rejected', requestStatus: 'APPROVED', assetId, actorId: userId });
  return row;
}

/**
 * ปลดการปิดถาวร — ทางออกเดียวของช่องที่ถูก cancel ไปแล้ว
 *
 * cancel ตั้งใจให้ "ปิดถาวร" (ช่องไม่คืนให้ลงใหม่ ดูตัวนับใน asset.service.create) เพราะการ
 * ตัดของทิ้งเป็นการตัดสินใจทางบัญชี ไม่ใช่การลบข้อมูลผิด — แต่คนกดผิดได้ และถ้าไม่มีทางกลับ
 * ทางแก้เดียวที่เหลือคือลบแถวทิ้งซึ่งทำลายหลักฐานว่าเคยมีของชิ้นนี้
 *
 * จำกัดที่ REGISTRAR_ROLES (บัญชี/แอดมิน) ที่ระดับ route — คนที่ปิดได้เท่านั้นที่เปิดคืนได้
 */
export async function uncancelAsset(requestId: number, assetId: number, userId: number) {
  assertRegistrationHolder(requestId, userId);
  const [target] = await db
    // หยิบสถานะใบมาด้วยในคิวรีเดิม — notifyStatus ต้องใช้ตัดสินว่าก้อนนี้ควรถึงหน้าคิวบัญชีไหม
    // (join ไม่เพิ่มรอบ round-trip และ where บังคับ requestId อยู่แล้ว จึงไม่มีทางได้แถวอื่น)
    .select({
      id: asset.id,
      lifecycle: asset.lifecycle,
      assetNumber: asset.assetNumber,
      requestStatus: assetRequest.status,
    })
    .from(asset)
    .innerJoin(assetRequest, eq(assetRequest.id, asset.requestId))
    .where(and(eq(asset.id, assetId), eq(asset.requestId, requestId), isNull(asset.deletedAt)));
  if (!target) throw new NotFoundError(`Asset ${assetId} ในคำขอ ${requestId}`);
  if (target.lifecycle !== 'CANCELLED') {
    throw new ConflictError('สินทรัพย์ชิ้นนี้ไม่ได้ถูกปิดถาวรอยู่');
  }

  const row = requireRow(
    await db
      .update(asset)
      .set({
        // ปลดการปิด = ย้อนคำสั่งเดิม ต้องได้สภาพก่อนปิดกลับมาเป๊ะ ๆ ไม่ใช่เด้งไปเป็นชิ้นเปล่าเสมอ
        // ชิ้นที่ปิดตอนมีเลขแล้วต้องกลับเป็น REGISTERED (ck_asset_registered_needs_number
        // บังคับให้มีเลขอยู่แล้ว ซึ่งเรายังเก็บไว้ตั้งแต่ตอน cancel)
        lifecycle: target.assetNumber ? 'REGISTERED' : 'DRAFT',
        // ล้างร่องรอยการปิดให้หมด ไม่ทิ้งไว้ — ถ้าเหลือ cancelReason ค้าง ป้ายบนจอจะขึ้นเหตุผล
        // ของการปิดครั้งก่อนบนชิ้นที่กลับมาทำงานปกติแล้ว
        cancelReason: null,
        cancelledAt: null,
        cancelledBy: null,
        updatedBy: userId,
        updatedAt: sql`now()`,
      })
      .where(and(eq(asset.id, assetId), eq(asset.lifecycle, 'CANCELLED')))
      .returning({ id: asset.id, lifecycle: asset.lifecycle }),
    `uncancel asset ${assetId}`,
  );

  presence.notifyStatus({ requestId, action: 'asset-uncancelled', requestStatus: target.requestStatus, assetId, actorId: userId });
  return row;
}

// ไม่มี cancelRequest แล้ว (0014) — การยกเลิกเป็นเรื่องของชิ้น ดู cancelAsset ข้างบน
// ใบที่ส่งไปแล้วแต่ไม่อยากได้ ให้หัวหน้า reject ส่วนของที่รับมาแล้วแต่ไม่ลงทะเบียน ให้บัญชี cancel รายชิ้น

// reject — manager ตีกลับ พร้อมเหตุผล → REJECTED (กลับมาแก้ได้เหมือน DRAFT)
export async function rejectRequest(
  id: number,
  managerId: number,
  reason: string,
  // role ณ ตอนกด — เก็บเป็น snapshot ไม่ derive ทีหลัง (ดู asset_request.rejectedRole)
  // APPROVER_ROLES มีทั้ง MANAGER/FINANCE/ADMIN การตีกลับทั้งใบจึงไม่ได้มาจากหัวหน้าเสมอไป
  role: string,
) {
  const req = await requireRequest(id);
  if (req.status !== 'PENDING_APPROVAL') {
    throw new ConflictError('ตีกลับได้เฉพาะคำขอที่รออนุมัติ');
  }
  const [row] = await db
    .update(assetRequest)
    .set({ status: 'REJECTED', rejectedBy: managerId, rejectedAt: sql`now()`, rejectReason: reason, rejectedRole: role, updatedAt: sql`now()` })
    .where(and(eq(assetRequest.id, id), eq(assetRequest.status, 'PENDING_APPROVAL')))
    .returning({ id: assetRequest.id, status: assetRequest.status });
  if (!row) throw new ConflictError('คำขอเพิ่งถูกเปลี่ยนสถานะ');
  presence.notifyStatus({ requestId: id, action: 'request-rejected', requestStatus: 'REJECTED', assetId: null, actorId: managerId });
  return row;
}
