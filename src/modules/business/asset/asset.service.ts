import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  isNull,
  max,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '@intrastucture/db';
import {
  asset,
  assetAccounting,
  assetRequest,
  assetRequestLine,
  grpoLine,
  attachment,
  category,
  assetLocation,
  assetSubLocation,
  department,
  employee,
  user,
  purchaseOrder,
} from '@intrastucture/db/schema';
import { NotFoundError, BadRequestError, ConflictError } from '@common/errors';
import { requireRow, requireScalar } from '@common/db-result';
import { isUniqueViolation } from '@common/pg-error';
import { declaredMap } from '@modules/business/asset-request/asset-request-line.service';
import * as presence from '@modules/business/asset-request/presence.service';
import { documentPersonName, employeeName, subLocationName } from '@modules/business/master/master.service';
import { createAssetBody, updateAssetBody } from './asset.schema';
import { paginate, type Paginated } from '@common/pagination';
import type {
  AssetRow,
  AssetSlot,
  AssetSlotsResponse,
  DeleteAssetResult,
  MasterRefInput,
  PendingSlotRef,
  RequestStatus,
  SlotDisplayStatus,
  SlotItem,
  MyAssetAccounting,
  MyAssetsResponse,
  AssetByNumberDetail,
  InventoryItem,
  InventoryListInput,
} from './asset.types';

// เผื่อเศษจากการหารราคาแบ่งชิ้น (10,000 ÷ 3) — ต่างระดับสตางค์ไม่ถือว่าเกิน
export const COST_TOLERANCE = 1;

type CreateBody = typeof createAssetBody.static;
type UpdateBody = typeof updateAssetBody.static;
async function assertMasterUsable(input: MasterRefInput): Promise<void> {

  // FK จับได้อยู่แล้วว่า id ไม่มีจริง แต่ error ของ pg อ่านไม่รู้เรื่อง และ FK จับ
  // "แผนกที่ถูกปิดใช้งาน" ไม่ได้เลย — แถวยังอยู่ FK จึงผ่าน
  if (input.departmentId != null) {
    const row = await db.query.department.findFirst({
      where: eq(department.id, input.departmentId),
    });
    if (!row) throw new BadRequestError(`ไม่พบแผนก id ${input.departmentId}`);
    if (!row.isActive) throw new BadRequestError(`แผนก "${row.name}" ถูกปิดใช้งานแล้ว`);
  }

  if (input.employeeId != null) {
    const row = await db.query.employee.findFirst({ where: eq(employee.id, input.employeeId) });
    if (!row) throw new BadRequestError(`ไม่พบพนักงานรหัส ${input.employeeId}`);
    // employee.name (ชื่อเต็มก้อนเดียว) ถูกถอดออกใน 0005 — ประกอบจากสองช่องแทน
    // ทั้งคู่ nullable จึงต้องมีทางถอย: ไม่มีชื่อเลยก็ยังต้องบอกได้ว่าใครถูกปิดใช้งาน
    // ตั้งชื่อ who ไม่ใช่ employeeName — ชื่อหลังถูกใช้เป็น helper ที่ import มาข้างบนแล้ว
    // (ตัวนี้เป็นสูตรย่อสำหรับข้อความ error เท่านั้น ไม่ใช่ชื่อที่เอาไปโชว์บนหน้าจอ)
    const who = [row.firstNameEn, row.lastNameEn].filter(Boolean).join(' ') || `id ${row.id}`;
    if (!row.isActive) throw new BadRequestError(`พนักงาน "${who}" ไม่ได้ทำงานแล้ว`);
  }

  if (input.locationId === undefined && input.subLocationId == null) return;

  const location =
    input.locationId === undefined
      ? undefined
      : await db.query.assetLocation.findFirst({ where: eq(assetLocation.id, input.locationId) });

  if (input.locationId !== undefined) {
    if (!location) throw new BadRequestError(`ไม่พบสถานที่ id ${input.locationId}`);
    if (!location.isActive) throw new BadRequestError(`สถานที่ "${location.name}" ถูกปิดใช้งานแล้ว`);
  }

  if (input.subLocationId == null) return;

  const sub = await db.query.assetSubLocation.findFirst({
    where: eq(assetSubLocation.id, input.subLocationId),
  });
  if (!sub) throw new BadRequestError(`ไม่พบตำแหน่งย่อย id ${input.subLocationId}`);
  if (!sub.isActive) throw new BadRequestError('ตำแหน่งย่อยที่เลือกถูกปิดใช้งานแล้ว');

  // ตำแหน่งย่อยต้องอยู่ใต้สถานที่ที่เลือก — ไม่เช็คแล้ว "ชั้น 2 ห้อง 201 ของสำนักงานใหญ่"
  // จะไปโผล่ใต้ "โรงงาน 1" ได้ ซึ่ง FK สองตัวแยกกันจับไม่ได้เลย
  if (input.locationId !== undefined && sub.locationId !== input.locationId) {
    throw new BadRequestError('ตำแหน่งย่อยที่เลือกไม่ได้อยู่ในสถานที่นี้');
  }
}

/** รูปที่แนบต้องเป็นไฟล์รูปจริง ยังไม่ถูกลบ และยังไม่มีชิ้นอื่นใช้อยู่ */
async function assertImageUsable(imageId: string, exceptAssetId?: number) {
  const file = await db.query.attachment.findFirst({
    where: and(eq(attachment.id, imageId), isNull(attachment.deletedAt)),
  });
  if (!file) throw new NotFoundError(`Attachment ${imageId}`);

  // composite FK กันเคสนี้ที่ระดับ DB อยู่แล้ว แต่ error ของ pg อ่านไม่รู้เรื่องสำหรับผู้ใช้
  if (file.docType !== 'ASSET_IMG') {
    throw new BadRequestError('ไฟล์นี้ไม่ใช่รูปสินทรัพย์ — แนบได้เฉพาะไฟล์ที่อัปโหลดเป็น ASSET_IMG');
  }

  const used = await db.query.asset.findFirst({ where: eq(asset.imageId, imageId) });
  if (used && used.id !== exceptAssetId) {
    throw new ConflictError(
      `รูปนี้ถูกใช้กับสินทรัพย์ชิ้นอื่นแล้ว (${used.serialNumber ?? `asset id ${used.id}`})`,
    );
  }
}

// ── create ───────────────────────────────────────────────────────────────────

export async function create(body: CreateBody, userId: number): Promise<AssetRow> {
  const request = await db.query.assetRequest.findFirst({
    where: and(eq(assetRequest.id, body.requestId), isNull(assetRequest.deletedAt)),
  });
  if (!request) throw new NotFoundError(`Asset request ${body.requestId}`);
  if (request.status !== 'DRAFT') {
    throw new BadRequestError(
      `คำขอนี้อยู่สถานะ ${request.status} แล้ว แก้ไขรายการได้เฉพาะตอนเป็น DRAFT`,
    );
  }

  const line = await db.query.grpoLine.findFirst({
    where: eq(grpoLine.id, body.grpoLineId),
    with: { poItem: true, grpo: true },
  });
  if (!line) throw new NotFoundError(`GRPO line ${body.grpoLineId}`);
  // ★ ไม่เช็คตรงนี้ = ยัด grpoLine ของ PO อื่นเข้ามาได้ แล้วยอดรวมของทั้งสองใบเพี้ยนพร้อมกัน
  if (line.poItem.poNumber !== request.poNumber) {
    throw new BadRequestError(
      `รอบรับของนี้เป็นของ PO ${line.poItem.poNumber} ไม่ใช่ ${request.poNumber}`,
    );
  }

  // [Q3] ยังลงได้อีกไหม — เพดานต่อรอบ: declaredQty ถ้ามีคนแจ้ง / ไม่มีก็ receivedQty ตาม SAP
  const declared = await db.query.assetRequestLine.findFirst({
    where: and(
      eq(assetRequestLine.requestId, body.requestId),
      eq(assetRequestLine.grpoLineId, body.grpoLineId),
    ),
  });
  const capOfRound = declared ? declared.declaredQty : line.receivedQty;

  // นับข้ามใบอยู่แล้ว (ผูกกับ grpoLineId ไม่ใช่ requestId) — PO เดียวหลายรอบจึงไม่กวนกัน
  //
  // ★ นับ CANCELLED ด้วย (0016) — "ปิดถาวร" แปลว่าช่องนั้นไม่คืนให้ใครใช้ต่อ
  //   เคยกันออกใน 0014 ตอนที่ cancel หมายถึง "ตัดทิ้งแล้วลงใหม่ได้" แต่กติกาเปลี่ยนแล้ว:
  //   บัญชีมีสามปุ่มแยกหน้าที่กันชัดเจน — reject (ให้ไปแก้แล้วกลับมา), cancel (ปิดถาวร),
  //   ออกเลข (จบ) การคืนช่องเป็นหน้าที่ของ reject ไม่ใช่ของ cancel
  //   ปลดการปิดต้องให้บัญชีกด uncancelAsset เท่านั้น
  const inThisLine = requireScalar(
    await db
      .select({ value: count() })
      .from(asset)
      .where(and(eq(asset.grpoLineId, body.grpoLineId), isNull(asset.deletedAt))),
    'count asset ในรอบรับของนี้',
  );
  if (inThisLine >= capOfRound) {
    throw new BadRequestError(
      declared
        ? `รอบ ${line.grpo.grpoNo} แจ้งไว้ ${capOfRound} ชิ้น และลงทะเบียนครบแล้ว — ถ้าของมีมากกว่านี้ต้องแก้จำนวนที่แจ้งก่อน`
        : `รอบ ${line.grpo.grpoNo} รับ "${line.poItem.itemDescription}" มา ${line.receivedQty} ชิ้น ` +
          `และลงทะเบียนครบแล้ว — ส่วนที่เหลือต้องรอรอบรับของถัดไป`,
    );
  }

  //   ต่อ PO line: บล็อกที่จำนวนสั่งเฉพาะบรรทัดที่ "ไม่มีใครแจ้งอะไรเลย" (กันรับเกินสั่งแล้วลงตามไปด้วย)
  //   บรรทัดที่มีการแจ้ง = หน่วยนับของ PO ใช้กับจำนวนชิ้นไม่ได้อยู่แล้ว (1 งาน = กล้อง 12 ตัว)
  //   จึงเกินได้ แต่ manager จะเห็นส่วนต่างพร้อมเหตุผลตอนอนุมัติ
  const linesOfItem = await db
    .select({ id: grpoLine.id })
    .from(grpoLine)
    .where(eq(grpoLine.poItemId, line.poItemId));
  const idsOfItem = linesOfItem.map((l) => l.id);

  // ⚠️ ต้องนับ "ทุกใบ" ไม่ใช่เฉพาะใบนี้ (แก้ใน 0014) — ตัวนี้เป็นสวิตช์ว่าจะเปิดเพดาน
  // "จำนวนที่สั่ง" หรือไม่ ถ้าดูแค่ใบตัวเอง: รอบ 1 แจ้ง 12 ชิ้นบนงานเหมา (PO quantity = 1)
  // แล้วรอบ 2 ที่ไม่ได้แจ้งจะเปิดเพดานกลับมา เห็นว่ามี 12 ชิ้นแล้ว → บล็อกของรอบ 2 ทั้งที่
  // เป็นของใหม่จริง การแจ้งจำนวนเป็นข้อเท็จจริงของ "PO line นั้น" ไม่ใช่ของใบใดใบหนึ่ง
  const declaredOnItem = requireScalar(
    await db
      .select({ value: count() })
      .from(assetRequestLine)
      .where(inArray(assetRequestLine.grpoLineId, idsOfItem)),
    'count การแจ้งจำนวนของ PO line นี้',
  );

  if (declaredOnItem === 0) {
    // นับ CANCELLED ด้วยเหตุผลเดียวกับ inThisLine ข้างบน — ช่องที่ปิดถาวรแล้วไม่คืน
    const inThisItem = requireScalar(
      await db
        .select({ value: count() })
        .from(asset)
        .where(and(inArray(asset.grpoLineId, idsOfItem), isNull(asset.deletedAt))),
      'count asset ของ PO line นี้',
    );
    if (inThisItem >= line.poItem.quantity) {
      throw new BadRequestError(
        `"${line.poItem.itemDescription}" สั่งไว้ ${line.poItem.quantity} ชิ้น ลงทะเบียนครบแล้ว`,
      );
    }
  }

  // [Q4] [Q5] ข้อมูลอ้างอิงและรูป
  await assertMasterUsable(body);
  if (body.imageId) await assertImageUsable(body.imageId);

  // เลขชิ้น: client ส่งเลขช่องที่ตัวเองกรอกมา (ตรงกับที่เห็นบนฟอร์ม) ไม่ส่งมาก็ต่อท้ายให้
  // ไม่ว่าทางไหน unique uq_asset_po_item_unit_no เป็นคนตัดสินตอนสองคนยิงชนกัน — ไม่ใช่การนับ
  // แยกตัวแปรใหม่แทนการเขียนทับ body.unitNo — ผลลัพธ์เป็น number แน่นอนตั้งแต่ประกาศ
  // ไม่ต้องพึ่ง narrowing ของ compiler และอ่านแล้วรู้ทันทีว่าไม่มีทางเป็น undefined
  // (max() คืน null ได้เมื่อยังไม่มีแถวไหนเลย — ชิ้นแรกจึงเริ่มที่ 1)
  const unitNo: number =
    body.unitNo ??
    (requireScalar(
      await db
        .select({ value: max(asset.unitNo) })
        .from(asset)
        .where(and(eq(asset.poItemId, line.poItemId), isNull(asset.deletedAt))),
      'max unitNo ของ PO line นี้',
    ) ?? 0) + 1;

  const row = requireRow(await insertAssetOrConflict({
      // ระบุชัดแม้คอลัมน์จะมี default เป็นค่านี้อยู่แล้ว — ck_asset_origin_chain ผูกความหมาย
      // ของทุกคอลัมน์ในโซ่ PO ไว้กับค่านี้ ปล่อยให้ default เงียบ ๆ ทำให้อ่านตรงนี้แล้วไม่เห็น
      // ว่าทำไม requestId/grpoLineId ถึงห้ามว่าง
      origin: 'PO_FLOW',
      // บริษัทเจ้าของชิ้นนี้ (0021) — เอาจากรอบรับของ ไม่ใช่จาก user ที่กดหรือค่า default
      // GRPO คือจุดที่ของเข้าบริษัทจริง และ grpo.companyCode มาจากฐาน SAP ที่ sync มา
      // ตรง ๆ จึงโกหกไม่ได้ (ไต่ผ่าน line.poItem ก็ได้ผลเดียวกัน แต่ต้อง join เพิ่ม)
      companyCode: line.grpo.companyCode,
      requestId: body.requestId,
      grpoLineId: body.grpoLineId,
      poItemId: line.poItemId,
      unitNo,
      // ราคาที่เสนอ — ชิ้นที่ n เกินจำนวนที่ GRPO รับมา = ชิ้นที่ "แตกเพิ่มเอง" (งานเหมา)
      // ทั้งบรรทัดแชร์งบก้อนเดียว (lineTotal) จะ default เป็น unitPrice ทุกชิ้นไม่ได้ ยอดรวมจะทะลุ
      // ชิ้นที่เกินจึงเริ่มที่ 0 ให้ผู้ใช้กระจายราคาจริงเอง / ชิ้นตาม SAP คงใช้ unitPrice ตามเดิม
      acquisitionCost:
        body.acquisitionCost ?? (inThisLine >= line.receivedQty ? 0 : line.poItem.unitPrice),
      // ชิ้นนี้เกิดเพราะคนแจ้งจำนวนเอง ไม่ได้มาจากตัวเลข SAP — ตรึงไว้ตลอดอายุสินทรัพย์
      isSplitItem: declared != null,
      description: body.description ?? line.poItem.itemDescription,
      serialNumber: body.serialNumber,
      assetClass: body.assetClass,
      // categoryId/uom ไม่เซ็ตตรงนี้ — ปล่อยเป็น NULL รอ sync ที่ map จาก OITM มาเติม (0007/0011)
      locationId: body.locationId,
      subLocationId: body.subLocationId,
      departmentId: body.departmentId,
      employeeId: body.employeeId,
      warrantyStartDate: body.warrantyStartDate,
      warrantyEndDate: body.warrantyEndDate,
      imageId: body.imageId,
      createdBy: userId,
      updatedBy: userId,
  }), `insert asset (PO line ${line.poItemId} ชิ้นที่ ${unitNo})`);

  presence.notifyStatus({
    requestId: body.requestId,
    action: 'asset-created',
    // ผ่านด่านข้างบนมาแล้ว = DRAFT เสมอ แต่อ่านจากใบจริงไว้ ไม่ฝังค่าคงที่ — วันที่กติกาขยาย
    // ให้ลงชิ้นได้ตอน REJECTED ด้วย ตัวกรองของ notifyStatus จะยังถูกโดยไม่มีใครต้องมาแก้ที่นี่
    requestStatus: request.status,
    assetId: row.id,
    actorId: userId,
  });
  return row;
}

// ชนกันที่ unique (poItemId, unitNo) = มีคนคว้าเลขช่องนั้นไปก่อนเสี้ยววินาที — เป็นเคสปกติ
// ของการแย่งกัน ไม่ใช่บั๊ก จึงแปลงเป็น 409 ให้ผู้ใช้โหลดใหม่ แทนที่จะโผล่เป็น 500
async function insertAssetOrConflict(values: typeof asset.$inferInsert) {
  try {
    return await db.insert(asset).values(values).returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        `ชิ้นที่ ${values.unitNo} ของรายการนี้เพิ่งถูกลงทะเบียนโดยผู้อื่น กรุณาโหลดหน้าใหม่`,
      );
    }
    throw error;
  }
}

// ── read ─────────────────────────────────────────────────────────────────────

export async function findOneOrFail(id: number) {
  const row = await db.query.asset.findFirst({
    where: and(eq(asset.id, id), isNull(asset.deletedAt)),
    with: {
      grpoLine: { with: { grpo: true, poItem: true } },
      category: true,
      location: true,
      subLocation: true,
      employee: true,
      image: true,
    },
  });
  if (!row) throw new NotFoundError(`Asset ${id}`);
  return row;
}

/**
 * ป้ายสถานะของชิ้นหนึ่ง — จุดเดียวในระบบที่ตัดสินใจเรื่องนี้
 *
 * ไล่จาก "จบแล้ว" ไปหา "ยังไม่เริ่ม" เพราะสถานะปลายทางต้องชนะเสมอ: ชิ้นที่ออกเลขแล้ว
 * ไม่ควรกลับไปขึ้น Pending Manager เพียงเพราะใบถูกตีกลับทีหลัง
 *
 * ⚠️ requestStatus ที่รับเข้ามาต้องเป็นของ "ใบเจ้าของชิ้น" เท่านั้น ห้ามส่งใบที่กำลังเปิดดูเข้ามา
 */
function slotDisplayStatus(
  lifecycle: AssetRow['lifecycle'],
  rejectedAt: string | null,
  requestStatus: RequestStatus | null,
): SlotDisplayStatus {
  // ปิดถาวรแล้ว — ไม่มีอะไรทำต่อได้อีก (บัญชีเท่านั้นที่ปลดได้)
  if (lifecycle === 'CANCELLED') return 'cancelled';
  // มีเลข SAP แล้ว = จบกระบวนการ
  if (lifecycle === 'REGISTERED') return 'registered';
  // ตีกลับรายชิ้นโดยบัญชี — ชนะสถานะใบ เพราะเกิดทีหลังการอนุมัติใบเสมอ
  if (rejectedAt) return 'rejected';

  switch (requestStatus) {
    case 'REJECTED':
      return 'rejected'; // หัวหน้าตีกลับทั้งใบ
    case 'PENDING_APPROVAL':
      return 'pendingManager';
    case 'APPROVED':
      return 'approved'; // รอบัญชีออกเลข
    // ใบยังไม่ถูกส่ง — กรอกไว้เฉย ๆ ยังไม่มีใครเห็น
    // null = ชิ้นที่ไม่ได้มาจาก PO flow (SAP_LEGACY) ซึ่งไม่มีใบให้ถาม จัดเป็น saved เหมือนกัน
    case 'DRAFT':
    case null:
    case undefined:
      return 'saved';
  }
}

/**
 * รายการ "ช่อง" ที่หน้าฟอร์มต้องเรนเดอร์ — ตัวเลขสองตัวคนละหน้าที่:
 *   po_item.quantity   = จะมีทั้งหมดกี่ชิ้น -> จำนวนช่องที่แสดง (คงที่ตั้งแต่เปิดใบ)
 *   Σ receivedQty      = ตอนนี้ของมาถึงแล้วกี่ชิ้น -> เส้นแบ่งว่าช่องไหนเปิดให้กรอก
 *
 * สถานะต่อช่อง:
 *   registered  มีแถวใน asset แล้ว
 *   pending     ของมาถึงแล้วและยังไม่ได้ลง -> กรอกได้
 *   noGrpo      ของยังมาไม่ถึง
 */
export async function findSlotsByRequest(requestId: number): Promise<AssetSlotsResponse> {
  const request = await db.query.assetRequest.findFirst({
    where: and(eq(assetRequest.id, requestId), isNull(assetRequest.deletedAt)),
    with: {
      purchaseOrder: {
        with: {
          items: {
            orderBy: (item, { asc }) => [asc(item.poLine)],
            with: {
              grpoLines: {
                with: { grpo: { with: { invoices: { with: { attachment: true } } } } },
                orderBy: (l, { asc }) => [asc(l.grpoId)],
              },
            },
          },
        },
      },
    },
  });
  if (!request) throw new NotFoundError(`Asset request ${requestId}`);

  // ★ นับ "ข้ามใบ" ไม่ใช่เฉพาะใบนี้ — ช่องเป็นของ PO line ไม่ใช่ของใบคำขอ
  //
  // PO เดียวเปิดใบคำขอได้หลายรอบ (ใบก่อนอนุมัติไปแล้ว ของล็อตหลังมาทีหลัง) ถ้าดูแค่
  // ใบตัวเอง ของที่ลงไปแล้วในใบก่อนจะโผล่เป็นช่องว่างให้กรอกซ้ำ แล้วตอนบันทึกจะไปชน
  // uq_asset_po_item_unit_no ทุกครั้ง — ตรงกับที่ create() นับเพดานข้ามใบอยู่แล้ว
  const poItemIds = request.purchaseOrder.items.map((item) => item.id);
  const registeredRows = poItemIds.length
    ? await db.query.asset.findMany({
        where: and(inArray(asset.poItemId, poItemIds), isNull(asset.deletedAt)),
        // location + subLocation มาด้วยเพราะใบแจ้งขออนุมัติ (Teams) ต้องบอกว่าของแต่ละชิ้น
        // จะไปอยู่ที่ไหน "รายชิ้น" ไม่ใช่รวมทั้งบรรทัด — ดึงมากับรอบนี้เลยแทนที่จะให้
        // frontend ยิง GET /assets/:id ทีละชิ้น
        // request มาด้วยเพราะป้ายสถานะของชิ้นต้องอ่านจาก "ใบเจ้าของชิ้น" ไม่ใช่ใบที่กำลังเปิดดู
        // — สองอย่างนี้ต่างกันได้เสมอ (แถวข้างบนนับข้ามใบ) และการใช้ใบที่เปิดดูคือบั๊กเดิม
        // ที่ทำให้ชิ้นซึ่งอนุมัติไปแล้วขึ้นป้าย Saved เมื่อดูผ่านใบรอบใหม่ของ PO เดียวกัน
        with: {
          grpoLine: { with: { grpo: true } },
          location: true,
          subLocation: true,
          request: true,
          // ผู้ถือครอง + แผนก: กล่องจัดการของบัญชีต้องเห็นครบก่อนตัดสินใจออกเลข/ตีกลับ
          // ดึงมาพร้อมรอบนี้แทนที่จะให้ frontend ยิง GET /assets/:id ทีละชิ้น (ใบละหลายสิบชิ้น)
          employee: true,
          department: true,
        },
        orderBy: (a, { asc }) => [asc(a.unitNo)],
      })
    : [];

  // ชื่อคนที่ตัดสินใจ (อนุมัติ/ตีกลับ/ปิดถาวร) — ดึงทีเดียวทั้งหน้าแล้ว map ตาม id
  // ไม่ join ทีละคอลัมน์: ต้อง alias ตาราง user ถึงสี่ครั้งบนคิวรีเดียว ซึ่งอ่านยากกว่ามาก
  // และรายชื่อพวกนี้ซ้ำกันเกือบทั้งหน้า (คนอนุมัติคนเดียวทั้งใบ)
  const actorIds = [
    ...new Set(
      registeredRows.flatMap((a) =>
        [a.request?.approvedBy, a.request?.rejectedBy, a.rejectedBy, a.cancelledBy, a.registeredBy].filter(
          (id): id is number => id != null,
        ),
      ),
    ),
  ];
  // ชื่อที่คนอ่านต้องเป็นชื่อพนักงานจาก HR (firstName + lastName) ไม่ใช่ displayName ของบัญชี
  // — displayName ตั้งเองได้ ซ้ำกันได้ และหลายคนตั้งเป็นชื่อเล่น/username ซึ่งผู้ขอที่เห็น
  // "ตีกลับโดย nat.s" แยกไม่ออกว่าเป็นใครและจะไปคุยกับใคร (ดู documentPersonName)
  //
  // leftJoin ไม่ใช่ innerJoin: บัญชีที่ยังไม่ผูกพนักงาน (service account) ก็ต้องมีชื่อกลับไป
  // ซึ่ง documentPersonName จะตกไปใช้ displayName ให้เอง
  const actorNames = new Map<number, string>(
    actorIds.length
      ? (
          await db
            .select({
              id: user.id,
              displayName: user.displayName,
              firstName: employee.firstName,
              lastName: employee.lastName,
              firstNameEn: employee.firstNameEn,
              lastNameEn: employee.lastNameEn,
              empId: employee.empId,
            })
            .from(user)
            .leftJoin(employee, eq(employee.id, user.employeeId))
            .where(inArray(user.id, actorIds))
        ).map((u) => [u.id, documentPersonName(u)])
      : [],
  );

  // แถวที่ผูกกับใบคำขอย่อมเป็น PO_FLOW เสมอ และ ck_asset_origin_chain บังคับให้โซ่ PO
  // ครบทุกคอลัมน์ — แต่ตั้งแต่ 0010 คอลัมน์พวกนั้นเปิดให้ NULL ได้ (เพื่อรับสินทรัพย์เก่า
  // จาก SAP ที่ไม่มี PO) compiler จึงมองเป็น nullable ทั้งแถบ
  //
  // กรองด้วย type predicate ทีเดียวแทนการโรย ! ทีละจุดข้างล่าง: ถ้าวันหลังมีแถวแปลกปลอม
  // หลุดเข้ามาจริง มันจะหายไปจากรายการช่อง ไม่ใช่ทำให้ทั้งหน้าพังด้วย TypeError
  type RegisteredRow = (typeof registeredRows)[number];
  const registered = registeredRows.filter(
    (
      a,
    ): a is RegisteredRow & {
      grpoLineId: string;
      poItemId: string;
      requestId: number;
      unitNo: number;
      acquisitionCost: number;
      grpoLine: NonNullable<RegisteredRow['grpoLine']>;
    } =>
      a.grpoLineId !== null &&
      a.poItemId !== null &&
      a.requestId !== null &&
      a.unitNo !== null &&
      a.acquisitionCost !== null &&
      a.grpoLine != null,
  );

  // รอบไหนถูกแจ้งจำนวนเองไว้บ้าง — ตัวตัดสินว่าเรนเดอร์กี่ช่อง
  const declared = await declaredMap(requestId);

  return {
    requestId,
    poNumber: request.poNumber,
    status: request.status,
    // เหตุผลที่ถูกตีกลับ — คู่กับ status เสมอ ผู้ใช้ที่เห็นว่าโดนตีกลับต้องรู้ในจอเดียวกัน
    // ว่าต้องแก้อะไร ไม่ใช่ต้องไปเปิดอีกหน้าเพื่อหาเหตุผล
    rejectReason: request.status === 'REJECTED' ? request.rejectReason : null,
    items: request.purchaseOrder.items.map((item): SlotItem => {
      const received = item.grpoLines.reduce((sum, l) => sum + l.receivedQty, 0);
      const capOf = (lineId: string, receivedQty: number) =>
        declared.get(lineId)?.declaredQty ?? receivedQty;
      const capTotal = item.grpoLines.reduce((sum, l) => sum + capOf(l.id, l.receivedQty), 0);
      const isDeclared = item.grpoLines.some((l) => declared.has(l.id));
      const planned = isDeclared ? capTotal : item.quantity;
      // ยึด poItemId ตรง ๆ ไม่ใช่ไล่ผ่าน grpoLines ของใบนี้ — asset ของใบก่อนอาจผูกกับ
      // รอบรับของที่ใบนี้ไม่ได้อ้างถึง แต่ก็ยังกินเลขช่องของ PO line เดียวกันอยู่ดี
      const mine = registered.filter((a) => a.poItemId === item.id);
      const regByLine = new Map<string, number>();
      for (const a of mine) regByLine.set(a.grpoLineId, (regByLine.get(a.grpoLineId) ?? 0) + 1);

      // เลขชิ้นถัดไปของ PO line นี้ — ต่อจากเลขสูงสุดที่ถูกใช้ไปแล้ว (สูตรเดียวกับ create())
      // ไม่ไล่อุดเลขที่ว่างระหว่างกลาง: ช่องที่ถูกลบไปแล้วคืนเลขให้ก็จริง แต่การอุดย้อนหลัง
      // ทำให้เลขชิ้นสลับที่กับที่ผู้ใช้เพิ่งเห็นบนจอ
      let nextUnitNo = mine.reduce((max, a) => Math.max(max, a.unitNo), 0) + 1;

      const pendingQueue: PendingSlotRef[] = [];
      for (const l of item.grpoLines) {
        // receivedQty เป็น numeric ได้ (SAP นับเป็น กก./ตัน ได้) แต่ช่องกรอกเป็นชิ้น
        // ปัดขึ้นเสมอ: รับมา 2.5 หน่วย ต้องมี 3 ช่อง ไม่ใช่ 2 ไม่งั้นของเศษสุดท้ายลงไม่ได้
        const remain = Math.ceil(capOf(l.id, l.receivedQty) - (regByLine.get(l.id) ?? 0));
        for (let k = 0; k < remain; k++) {
          pendingQueue.push({ grpoLineId: l.id, grpoNo: l.grpo.grpoNo });
        }
      }
      let pendingPointer = 0;
      // ปัดขึ้นด้วยเหตุผลเดียวกับ remain — planned มาจาก quantity/receivedQty ที่เป็น numeric
      const slotCount = Math.max(Math.ceil(planned), mine.length);

      const slots: AssetSlot[] = Array.from({ length: slotCount }, (_, i): AssetSlot => {
        const existing = mine[i];
        if (existing) {
          // ตีกลับรายชิ้น (บัญชี) มาก่อนตีกลับทั้งใบ (หัวหน้า) — ชิ้นที่มีทั้งคู่แปลว่าใบเคยถูก
          // ตีกลับ แก้แล้วส่งใหม่ ผ่านอนุมัติ แล้วบัญชีเพิ่งตีกลับอีกที เหตุผลที่ผู้ใช้ต้องอ่าน
          // คืออันหลัง ไม่ใช่อันที่แก้ไปแล้ว
          const rejectedOnAsset = existing.rejectedAt != null;
          const rejectedOnRequest = existing.request?.status === 'REJECTED';
          return {
            index: i + 1,
            status: 'registered' as const,
            displayStatus: slotDisplayStatus(
              existing.lifecycle,
              existing.rejectedAt,
              existing.request?.status ?? null,
            ),
            assetId: existing.id,
            assetNumber: existing.assetNumber,
            qrCode: existing.qrCode,
            // ใครออกเลขให้ชิ้นนี้ — คู่กับ approvedByName ตอบว่า "ใครอนุมัติ ใครปิดงาน"
            registeredByName:
              existing.registeredBy != null ? (actorNames.get(existing.registeredBy) ?? null) : null,
            approvedByName:
              existing.request?.approvedBy != null
                ? (actorNames.get(existing.request.approvedBy) ?? null)
                : null,
            rejectReason: rejectedOnAsset
              ? existing.rejectReason
              : rejectedOnRequest
                ? (existing.request?.rejectReason ?? null)
                : null,
            rejectedByName: rejectedOnAsset
              ? existing.rejectedBy != null
                ? (actorNames.get(existing.rejectedBy) ?? null)
                : null
              : rejectedOnRequest && existing.request?.rejectedBy != null
                ? (actorNames.get(existing.request.rejectedBy) ?? null)
                : null,
            rejectedRole: rejectedOnAsset
              ? existing.rejectedRole
              : rejectedOnRequest
                ? (existing.request?.rejectedRole ?? null)
                : null,
            /**
             * ชิ้นนี้เพิ่งถูกแก้กลับมาจากการตีกลับ (ยังไม่ได้ออกเลข) — บัญชีใช้แยกว่าชิ้นไหน
             * "ต้องตรวจซ้ำว่าแก้ตามที่สั่งไปหรือยัง" ออกจากชิ้นปกติที่ไม่เคยมีปัญหา
             * ส่งเป็น boolean ไม่ใช่ timestamp: หน้าจอต้องการแค่ป้าย ไม่ได้แสดงเวลา
             */
            rejectFixed: existing.rejectFixedAt != null,
            cancelReason: existing.lifecycle === 'CANCELLED' ? existing.cancelReason : null,
            cancelledByName:
              existing.lifecycle === 'CANCELLED' && existing.cancelledBy != null
                ? (actorNames.get(existing.cancelledBy) ?? null)
                : null,
            // เลขชิ้นจริงในตาราง ไม่ใช่ลำดับบนจอ — สองค่านี้ต่างกันได้เมื่อ PO line นี้
            // ถูกลงทะเบียนมาแล้วหลายใบ หรือมีชิ้นที่ถูกลบไป
            unitNo: existing.unitNo,
            // ชิ้นนี้เป็นของใบไหน — ใบอื่นแปลว่าอ่านได้อย่างเดียว (แก้/ลบต้องไปทำที่ใบเจ้าของ)
            // และการ์ดแจ้งอนุมัติของใบนี้ต้องไม่นับรวมเข้าไปด้วย
            requestId: existing.requestId,
            serialNumber: existing.serialNumber,
            acquisitionCost: existing.acquisitionCost, // ราคาจริงต่อชิ้น (ชิ้นเกิน = 0 ตาม default)
            // lifecycle จริงของชิ้น: DRAFT = ยังไม่เข้า SAP (badge "requested") / REGISTERED = ลง SAP แล้ว
            lifecycle: existing.lifecycle,
            // ให้ตารางแสดงรูปย่อได้โดยไม่ต้องยิง GET /assets/:id ทีละชิ้น
            // ส่งแค่ id ไม่ส่ง URL — ไฟล์อยู่หลัง authGuard ฝั่ง client ต้องแนบ token เอง
            imageId: existing.imageId,
            // ชื่อสถานที่ (ไม่ใช่ id) — ผู้อนุมัติใน Teams อ่าน id ไม่รู้เรื่อง
            // ส่งแยกสองช่อง ไม่ประกอบเป็นสตริงเดียวที่นี่: หน้าฟอร์มใช้ทีละช่อง
            // ส่วนการประกอบ "ที่ - ที่ย่อย" เป็นเรื่องของใบแจ้งอนุมัติเท่านั้น
            locationName: existing.location?.name ?? null,
            // ใช้ subLocationName() ตัวเดียวกับ dropdown ในฟอร์ม (ตารางไม่มีคอลัมน์ name
            // มีแต่ floor/room/remark) — คนละสูตรเมื่อไหร่ ผู้อนุมัติจะเห็นคนละข้อความกับที่ผู้ใช้เลือก
            subLocationName: existing.subLocation ? subLocationName(existing.subLocation) : null,
            // employeeName() ตัวเดียวกับที่ dropdown ในฟอร์มใช้ — คนละสูตรเมื่อไหร่ ชื่อที่บัญชี
            // เห็นจะไม่ตรงกับที่ผู้ขอเลือกไว้ (เหตุผลเดียวกับ subLocationName ข้างบน)
            employeeName: existing.employee ? employeeName(existing.employee) : null,
            departmentName: existing.department?.name ?? null,
            warrantyStartDate: existing.warrantyStartDate,
            warrantyEndDate: existing.warrantyEndDate,
            grpoLineId: existing.grpoLineId,
            grpoNo: existing.grpoLine.grpo.grpoNo,
          };
        }
        const alloc = pendingQueue[pendingPointer++];
        if (alloc) {
          return {
            index: i + 1,
            status: 'pending' as const,
            displayStatus: 'pendingCreation' as const,
            // client ส่งเลขนี้กลับมาตอน POST /assets — เดิมส่งลำดับบนจอ (1,2,3...) ซึ่งชน
            // ของใบก่อนทุกครั้งเมื่อ PO line เดิมถูกลงทะเบียนไปแล้ว
            unitNo: nextUnitNo++,
            grpoLineId: alloc.grpoLineId,
            grpoNo: alloc.grpoNo,
          };
        }
        return { index: i + 1, status: 'noGrpo' as const, displayStatus: 'noGrpo' as const };
      });

      return {
        poItemId: item.id,
        poLine: item.poLine,
        itemDescription: item.itemDescription,
        unitPrice: item.unitPrice,
        lineTotal: item.lineTotal,
        ordered: item.quantity,
        received,
        registered: mine.length,
        planned,
        lineAmount: item.lineTotal,
        registeredCost: mine.reduce((sum, a) => sum + a.acquisitionCost, 0),
        isDeclared,
        overQty: planned > item.quantity,
        overCost: mine.reduce((sum, a) => sum + a.acquisitionCost, 0) >  (item.lineTotal ?? 0) + COST_TOLERANCE,
        grpoLines: item.grpoLines.map((l) => ({
          id: l.id,
          grpoId: l.grpoId, // integer — ใช้เรียก PATCH/DELETE /grpo/:id/invoice
          grpoNo: l.grpo.grpoNo,
          grpoDate: l.grpo.grpoDate,
          receivedQty: l.receivedQty,
          declaredQty: declared.get(l.id)?.declaredQty ?? null,
          declaredReason: declared.get(l.id)?.reason ?? null,
          registered: registered.filter((a) => a.grpoLineId === l.id).length,
          // invoice ทั้งหมดที่แนบกับรอบนี้ (1 รอบมีได้หลายใบ) — frontend ใช้เรนเดอร์รายการ/ปุ่ม
          invoices: l.grpo.invoices.map((gi) => ({
            id: gi.attachment.id,
            originalName: gi.attachment.originalName,
            mimeType: gi.attachment.mimeType,
            size: gi.attachment.size,
          })),
        })),
        slots,
      };
    }),
  };
}

// ── update / delete ──────────────────────────────────────────────────────────

export async function update(id: number, body: UpdateBody, userId: number): Promise<AssetRow> {
  const current = await db.query.asset.findFirst({
    where: and(eq(asset.id, id), isNull(asset.deletedAt)),
    with: { request: true },
  });
  if (!current) throw new NotFoundError(`Asset ${id}`);
  // ชิ้นที่จบไปแล้วแก้ไม่ได้ ไม่ว่าใบจะอยู่สถานะไหน — เช็คก่อนกติกาของใบเพราะเป็นคนละแกน
  // (ของที่อยู่ในทะเบียน SAP ต้องแก้ที่ SAP / ของที่ปิดถาวรต้องให้บัญชีปลดล็อกก่อน)
  if (current.lifecycle === 'REGISTERED') {
    throw new BadRequestError(
      `สินทรัพย์ชิ้นนี้ออกเลขแล้ว (${current.assetNumber}) แก้ที่นี่ไม่ได้ — ต้องแก้ที่ SAP`,
    );
  }
  if (current.lifecycle === 'CANCELLED') {
    throw new BadRequestError('สินทรัพย์ชิ้นนี้ถูกปิดถาวรแล้ว — ให้บัญชีปลดการปิดก่อนจึงจะแก้ได้');
  }

  // สินทรัพย์เก่าจาก SAP (SAP_LEGACY) ไม่มีใบคำขอ — กติกาของใบจึงใช้ไม่ได้และไม่ควรใช้
  // ของพวกนี้ถูกดึงมาเพื่อให้แก้ที่ตั้ง/ผู้ถือครอง/QR ได้เป็นเรื่องหลัก ถ้าบล็อกไว้ด้วย
  // เงื่อนไขของ flow ที่มันไม่ได้เดินมา ก็จะแก้อะไรไม่ได้เลยสักอย่าง
  if (current.request) {
    const status = current.request.status;
    // DRAFT = ยังไม่ส่ง / REJECTED = หัวหน้าตีกลับทั้งใบ ต้องแก้แล้วส่งใหม่
    // ★ REJECTED เคยไม่อยู่ในนี้ ซึ่งทำให้ใบที่ถูกตีกลับแก้อะไรไม่ได้เลยสักชิ้น — flow
    //   "ตีกลับแล้วแก้แล้วส่งใหม่" จึงตายสนิททั้งที่ submitRequest เปิดทางให้ส่งซ้ำอยู่
    const requestEditable = status === 'DRAFT' || status === 'REJECTED';
    // ใบผ่านอนุมัติแล้วแต่บัญชีตีกลับเฉพาะชิ้นนี้ — เปิดให้แก้ "เฉพาะชิ้นที่ถูกตีกลับ" เท่านั้น
    // ไม่ปลดทั้งใบ: ชิ้นอื่นในใบเดียวกันบัญชีอาจกำลังออกเลขอยู่ ปล่อยให้แก้ระหว่างนั้นไม่ได้
    const rejectedPiece = status === 'APPROVED' && current.rejectedAt != null;
    if (!requestEditable && !rejectedPiece) {
      throw new BadRequestError(
        status === 'APPROVED'
          ? 'คำขอนี้อนุมัติแล้ว แก้ไขได้เฉพาะชิ้นที่บัญชีตีกลับมาเท่านั้น'
          : `คำขอนี้อยู่สถานะ ${status} แล้ว แก้ไขรายการได้เฉพาะตอนเป็น DRAFT หรือ REJECTED`,
      );
    }
  }

  await assertMasterUsable({
    ...body,
    // ถ้าแก้เฉพาะ subLocation ต้องเทียบกับ location เดิมที่ยังใช้อยู่ ไม่ใช่ปล่อยผ่าน
    locationId: body.locationId ?? current.locationId,
  });
  if (body.imageId) await assertImageUsable(body.imageId, id);

  // ย้ายรอบรับของ: ต้องเป็นรอบของ PO line เดิม (composite FK กันไว้อีกชั้น) และรอบปลายทางต้องยังมีที่ว่าง
  if (body.grpoLineId && body.grpoLineId !== current.grpoLineId) {
    // ของที่ไม่ได้มาทางจัดซื้อไม่มี "รอบรับของ" ให้ย้ายตั้งแต่ต้น — ปล่อยผ่านจะได้แถวที่
    // มี grpoLineId แต่ requestId/poItemId ว่าง ซึ่ง ck_asset_origin_chain ปฏิเสธอยู่แล้ว
    // ดักที่นี่เพื่อให้ได้ข้อความที่บอกสาเหตุ แทน error ของ constraint ที่คนอ่านไม่รู้เรื่อง
    if (current.origin !== 'PO_FLOW' || current.requestId === null) {
      throw new BadRequestError('สินทรัพย์นี้ไม่ได้มาจากการจัดซื้อใน AMS จึงไม่มีรอบรับของให้ย้าย');
    }
    const target = await db.query.grpoLine.findFirst({
      where: eq(grpoLine.id, body.grpoLineId),
      with: { grpo: true },
    });
    if (!target) throw new NotFoundError(`GRPO line ${body.grpoLineId}`);
    if (target.poItemId !== current.poItemId) {
      throw new BadRequestError('ย้ายรอบรับของข้ามรายการ PO ไม่ได้ — ต้องเป็นรอบของบรรทัดเดิม');
    }

    const declaredTarget = await db.query.assetRequestLine.findFirst({
      where: and(
        eq(assetRequestLine.requestId, current.requestId),
        eq(assetRequestLine.grpoLineId, body.grpoLineId),
      ),
    });
    const capOfTarget = declaredTarget ? declaredTarget.declaredQty : target.receivedQty;
    const inTarget = requireScalar(
      await db
        .select({ value: count() })
        .from(asset)
        .where(and(eq(asset.grpoLineId, body.grpoLineId), isNull(asset.deletedAt))),
      'count asset ในรอบรับของปลายทาง',
    );
    if (inTarget >= capOfTarget) {
      throw new BadRequestError(`รอบ ${target.grpo.grpoNo} เต็มแล้ว (${capOfTarget} ชิ้น)`);
    }
  }

  const row = requireRow(
    await db
      .update(asset)
      .set({
        ...body,
        // ★ แก้ข้อมูลแล้ว = ส่งกลับเข้าคิวบัญชีอีกครั้ง สถานะตีกลับรายชิ้นจึงต้องหายไปเอง
        //   ไม่มีปุ่ม "ส่งกลับ" แยกโดยตั้งใจ — ปุ่มนั้นจะกลายเป็นขั้นที่ผู้ใช้ลืมกดแล้วชิ้นค้าง
        //   อยู่ในสถานะ Rejected ตลอดกาลทั้งที่แก้ไปแล้ว (บัญชีก็ไม่รู้ว่าต้องมาดูอีกรอบ)
        //   ล้างทั้งสี่ช่องพร้อมกันเพราะ ck_asset_reject_trio บังคับให้มาเป็นชุด
        //   rejectFixedAt เก็บไว้แทนว่า "รอบนี้เคยถูกตีกลับแล้วแก้กลับมา" — บัญชีต้องแยกออก
        //   จากชิ้นปกติที่ไม่เคยมีปัญหา ตอนไล่ตรวจก่อนออกเลข (ดูคอมเมนต์ที่คอลัมน์)
        ...(current.rejectedAt
          ? {
              rejectedAt: null,
              rejectedBy: null,
              rejectReason: null,
              rejectedRole: null,
              rejectFixedAt: sqlNow(),
            }
          : {}),
        updatedBy: userId,
        updatedAt: sqlNow(),
      })
      .where(eq(asset.id, id))
      .returning(),
    `update asset ${id}`,
  );

  // SAP_LEGACY ไม่มีใบคำขอ (requestId = null) — ไม่มีห้อง presence ให้กระจายและไม่มีหน้าคิว
  // ที่รอดูอยู่ ข้ามไปเลย ไม่ใช่ยิงด้วย requestId ปลอม ๆ
  //
  // ★ ก้อนนี้สำคัญกับฝั่งบัญชีเป็นพิเศษ: ผู้ขอแก้ชิ้นที่ถูกตีกลับ = ชิ้นนั้นกลับเข้าคิวออกเลข
  // ทันที (update ล้าง rejectedAt ให้เองข้างบน) บัญชีที่นั่งเปิดใบนี้ค้างอยู่ต้องเห็นเอง
  // ไม่ใช่รอเดารีเฟรชว่าผู้ขอแก้เสร็จแล้วหรือยัง
  if (current.request) {
    presence.notifyStatus({
      requestId: current.request.id,
      action: 'asset-updated',
      requestStatus: current.request.status,
      assetId: row.id,
      actorId: userId,
    });
  }
  return row;
}

export async function softDelete(id: number, userId: number): Promise<DeleteAssetResult> {
  const current = await db.query.asset.findFirst({
    where: and(eq(asset.id, id), isNull(asset.deletedAt)),
    with: { request: true },
  });
  if (!current) throw new NotFoundError(`Asset ${id}`);
  // เหตุผลเดียวกับ update() — SAP_LEGACY ไม่มีใบคำขอให้เช็คสถานะ
  // (ลบแล้ว connector จะไม่ปลุกกลับมา — ดู "เคารพการลบ" ใน asset.connector.ts)
  if (current.request && current.request.status !== 'DRAFT') {
    throw new BadRequestError(
      `คำขอนี้อยู่สถานะ ${current.request.status} แล้ว ลบรายการได้เฉพาะตอนเป็น DRAFT`,
    );
  }

  // ไม่ลบไฟล์รูปที่ผูกอยู่ — ปล่อยให้ cleanupOrphans ตัดสินใจทีหลังว่ากำพร้าจริงไหม
  // (แถวนี้ถูก soft delete แล้วแต่ยังชี้ imageId อยู่ ไฟล์จึงยังไม่กำพร้า จนกว่าจะลบจริง)
  const row = requireRow(
    await db
      .update(asset)
      .set({ deletedAt: sqlNow(), deletedBy: userId, updatedBy: userId, updatedAt: sqlNow() })
      .where(eq(asset.id, id))
      .returning(),
    `soft delete asset ${id}`,
  );

  // SAP_LEGACY ไม่มีใบคำขอ — ไม่มีห้อง presence ให้กระจายและไม่มีหน้าคิวที่รอดูอยู่
  if (current.request) {
    presence.notifyStatus({
      requestId: current.request.id,
      action: 'asset-deleted',
      requestStatus: current.request.status,
      assetId: row.id,
      actorId: userId,
    });
  }
  return { success: true, id: row.id };
}

// เลี่ยง import sql ทั้งก้อนเพื่อใช้ now() ที่เดียว — เขียนเป็น helper ให้อ่านง่าย
function sqlNow() {
  return new Date().toISOString();
}

/**
 * "สินทรัพย์ในความดูแลของฉัน" — หน้า My asset
 *
 * ── ผูกด้วย employee ไม่ใช่ user
 *
 * asset.employeeId ชี้ไปที่ตาราง employee ส่วนคนที่ล็อกอินคือ user จึงต้องเด้งผ่าน
 * user.employeeId ก่อนหนึ่งต่อ — บัญชีที่ยังไม่ผูกพนักงานตอบ linkedToEmployee: false
 * ไม่ใช่ items ว่าง (ดูเหตุผลที่ MyAssetsResponse)
 *
 * ── เอาเฉพาะ REGISTERED
 *
 * ชิ้นที่ยังเป็นร่างคือของที่ยังลงทะเบียนไม่เสร็จ ยังไม่มีเลขสินทรัพย์ ไม่มี QR ให้ติด
 * เอามาแสดงในหน้า "ของฉัน" จะทำให้คนเข้าใจว่ารับผิดชอบของที่ระบบยังไม่ยอมรับว่ามีอยู่
 *
 * ── มูลค่าบัญชีเป็น LEFT JOIN
 *
 * ชิ้นที่ SAP ยังไม่มียอดให้ต้องยังโผล่ในลิสต์ตามปกติ แค่ไม่มีตัวเลข — ของที่ลงทะเบียน
 * ผ่าน AMS (PO_FLOW) ส่วนใหญ่ยังไม่มียอดจนกว่าบัญชีจะออกเลขให้ใน SAP
 *
 * ⚠️ netBookValue คำนวณที่นี่ที่เดียว ห้ามให้ frontend ลบเอง — ไม่งั้นวันที่กติกาเปลี่ยน
 * (เช่นต้องหักมูลค่าซากด้วย) จะมีสูตรสองที่ที่ไม่ตรงกัน
 */
export async function findMine(userId: number): Promise<MyAssetsResponse> {
  const me = await db.query.user.findFirst({
    where: eq(user.id, userId),
    columns: { employeeId: true },
  });
  if (!me?.employeeId) return { linkedToEmployee: false, items: [] };

  const rows = await db
    .select({
      id: asset.id,
      companyCode: asset.companyCode,
      assetNumber: asset.assetNumber,
      description: asset.description,
      imageId: asset.imageId,
      qrCode: asset.qrCode,
      acquisitionDate: asset.acquisitionDate,
      acquisitionCost: asset.acquisitionCost,
      categoryName: category.name,
      locationName: assetLocation.name,
      subLocation: {
        id: assetSubLocation.id,
        floor: assetSubLocation.floor,
        room: assetSubLocation.room,
        remark: assetSubLocation.remark,
      },
      accounting: {
        fiscalYear: assetAccounting.fiscalYear,
        bookedCost: assetAccounting.bookedCost,
        accumulatedDepreciation: assetAccounting.accumulatedDepreciation,
        salvageValue: assetAccounting.salvageValue,
        usefulLifeMonths: assetAccounting.usefulLifeMonths,
        remainingLifeMonths: assetAccounting.remainingLifeMonths,
        depreciationMethod: assetAccounting.depreciationMethod,
        depreciationStart: assetAccounting.depreciationStart,
        depreciationEnd: assetAccounting.depreciationEnd,
        syncedAt: assetAccounting.syncedAt,
      },
    })
    .from(asset)
    .leftJoin(category, eq(category.id, asset.categoryId))
    .innerJoin(assetLocation, eq(assetLocation.id, asset.locationId))
    .leftJoin(assetSubLocation, eq(assetSubLocation.id, asset.subLocationId))
    .leftJoin(assetAccounting, eq(assetAccounting.assetId, asset.id))
    .where(
      and(
        eq(asset.employeeId, me.employeeId),
        isNull(asset.deletedAt),
        eq(asset.lifecycle, 'REGISTERED'),
      ),
    )
    .orderBy(asc(asset.assetNumber));

  return {
    linkedToEmployee: true,
    items: rows.map((r) => ({
      id: r.id,
      companyCode: r.companyCode,
      assetNumber: r.assetNumber,
      description: r.description,
      imageId: r.imageId,
      qrCode: r.qrCode,
      categoryName: r.categoryName,
      locationName: r.locationName,
      subLocationName: r.subLocation?.id ? subLocationName(r.subLocation) : null,
      acquisitionDate: r.acquisitionDate,
      acquisitionCost: r.acquisitionCost,
      accounting: toMyAssetAccounting(r.accounting),
    })),
  };
}

type AccountingColumns = {
  fiscalYear: number;
  bookedCost: number | null;
  accumulatedDepreciation: number | null;
  salvageValue: number | null;
  usefulLifeMonths: number | null;
  remainingLifeMonths: number | null;
  depreciationMethod: string | null;
  depreciationStart: string | null;
  depreciationEnd: string | null;
  syncedAt: string;
};

/**
 * LEFT JOIN ที่ไม่เจอคู่ → drizzle คืนก้อนนี้เป็น null ทั้งก้อน (ไม่ใช่ object ที่ทุกช่องเป็น null)
 * จึงเช็คที่ตัวก้อนได้เลย ไม่ต้องไล่ทีละช่อง — และ fiscalYear/syncedAt เป็น NOT NULL
 * ในตาราง ชนิดข้างในจึงไม่ต้องเผื่อ null ซ้ำ
 */
function toMyAssetAccounting(a: AccountingColumns | null): MyAssetAccounting | null {
  if (a === null) return null;
  return {
    fiscalYear: a.fiscalYear,
    bookedCost: a.bookedCost,
    accumulatedDepreciation: a.accumulatedDepreciation,
    // ขาดตัวใดตัวหนึ่ง = ตอบไม่ได้ ห้ามเดาเป็น 0 — 0 แปลว่า "ค่าเสื่อมหมดแล้ว" ซึ่งคนละเรื่อง
    netBookValue:
      a.bookedCost === null || a.accumulatedDepreciation === null
        ? null
        : a.bookedCost - a.accumulatedDepreciation,
    salvageValue: a.salvageValue,
    usefulLifeMonths: a.usefulLifeMonths,
    remainingLifeMonths: a.remainingLifeMonths,
    depreciationMethod: a.depreciationMethod,
    depreciationStart: a.depreciationStart,
    depreciationEnd: a.depreciationEnd,
    syncedAt: a.syncedAt,
  };
}

/**
 * เปิดจากการสแกน QR — ค้นด้วย "เลขสินทรัพย์" ไม่ใช่ id
 *
 * ── ทำไมรับเป็น query ไม่ใช่ path parameter
 *
 * เลขสินทรัพย์จริงมีตัวที่มี '/' อยู่ด้วย (MAC-212-13-001/1, MAC-1-21/12-002) พอ encode
 * เป็น %2F แล้วยัดใน path จะไปเจอกับ router/reverse proxy ที่ decode ก่อน match ทำให้
 * segment แตกเป็นสองท่อนแล้ว 404 โดยไม่มีอะไรบอกว่าทำไม — query string ไม่มีปัญหานี้
 *
 * ── เปิดสาธารณะ แต่ตัวเลขเงินขึ้นเฉพาะคนที่ล็อกอินแล้ว
 *
 * คนที่สแกนคือคนที่ยืนอยู่หน้าเครื่องจริง อาจเป็นใครก็ได้ รวมถึงคนที่ไม่มีบัญชีในระบบเลย
 * (ช่างที่มาซ่อม/ผู้รับเหมา) ถ้าบังคับล็อกอินก่อน สติกเกอร์จะใช้ไม่ได้กับคนกลุ่มนั้นทั้งหมด
 *
 * ★ แต่ URL เดาได้ไม่ยากถ้ารู้รูปแบบเลข — ปล่อยราคาทุน/ค่าเสื่อม/มูลค่าคงเหลือให้คนนอกเห็น
 *   = เปิดมูลค่าทรัพย์สินทั้งบริษัทให้ใครก็ได้ไล่ดูทีละชิ้น ตัวเลขเงินจึงตัดออกเมื่อไม่มี token
 *   ส่วนข้อมูลระบุตัวของ (เลข/ชื่อ/ที่ตั้ง/ผู้ดูแล) ปล่อยได้ — มันอยู่บนตัวเครื่องให้เห็นอยู่แล้ว
 *   และเป็นสิ่งเดียวที่ทำให้สแกนแล้วมีประโยชน์
 */
export async function findByAssetNumber(
  assetNumber: string,
  companyCode: string,
): Promise<AssetByNumberDetail> {
  const number = assetNumber.trim();
  if (!number) throw new BadRequestError('ต้องระบุเลขสินทรัพย์');

  const row = await db.query.asset.findFirst({
    // ★ ต้องระบุบริษัท ไม่ใช่เรื่องสิทธิ์แต่เป็นเรื่องความกำกวม: เลขสินทรัพย์ซ้ำกัน
    //   ข้ามบริษัทจริง 24 ตัว (วัดจาก OITM) — เลขเปล่าจึงตอบได้สองชิ้น
    //   บริษัทมาจาก URL ของ QR ซึ่ง assetQrUrl ฝังไว้ให้แล้ว
    where: and(
      eq(asset.assetNumber, number),
      eq(asset.companyCode, companyCode),
      isNull(asset.deletedAt),
    ),
    with: {
      category: true,
      location: true,
      subLocation: true,
      department: true,
      employee: true,
    },
  });
  // ข้อความต้องบอกเลขที่สแกนมาด้วย — คนยืนอยู่หน้าเครื่องจะได้รู้ว่าสแกนติดจริงแต่ไม่มีในระบบ
  // (ต่างจาก "สแกนไม่ติด" ซึ่งแก้คนละแบบ)
  if (!row) throw new NotFoundError(`สินทรัพย์เลข ${number}`);

  const [accounting] = await db
    .select()
    .from(assetAccounting)
    .where(eq(assetAccounting.assetId, row.id));

  return {
    id: row.id,
    assetNumber: number,
    description: row.description,
    imageId: row.imageId,
    serialNumber: row.serialNumber,
    uom: row.uom,
    assetClass: row.assetClass,
    status: row.status,
    lifecycle: row.lifecycle,
    categoryName: row.category?.name ?? null,
    locationName: row.location.name,
    subLocationName: row.subLocation ? subLocationName(row.subLocation) : null,
    departmentName: row.department?.name ?? null,
    holderName: row.employee ? employeeName(row.employee) : null,
    acquisitionDate: row.acquisitionDate,
    acquisitionCost: row.acquisitionCost,
    warrantyStartDate: row.warrantyStartDate,
    warrantyEndDate: row.warrantyEndDate,
    accounting: toMyAssetAccounting(accounting ?? null),
  };
}

/**
 * ═══ หน้า Asset Inventory — ทะเบียนสินทรัพย์ทั้งบริษัท ═══
 *
 * ต่างจาก findMine ตรงที่ **ไม่จำกัดขอบเขตตามคนที่ล็อกอิน** — ทุก role เห็นทุกชิ้น
 * ตั้งใจ ไม่ใช่ลืมใส่: หน้านี้ตอบคำถาม "ของชิ้นนี้อยู่ไหน ใครดูแล" ซึ่งคนที่ตามหาเครื่อง
 * มักไม่ใช่คนแผนกเดียวกับที่ของสังกัดอยู่ (ช่างซ่อม/คนตรวจนับ/คนยืมข้ามแผนก)
 * ข้อมูลชุดนี้เป็นชุดเดียวกับที่ปล่อยให้คนสแกน QR เห็นอยู่แล้ว (ดู findByAssetNumber)
 *
 * แสดงเฉพาะ lifecycle = 'REGISTERED' ที่ยังไม่ถูกลบ:
 *   - DRAFT ยังไม่มีเลขสินทรัพย์ จึงไม่มีอะไรให้ค้นและกดเข้าไปดูไม่ได้ (หน้ารายละเอียด
 *     ใช้เลขเป็นกุญแจ) ของที่ยังไม่ออกเลขมีหน้าของตัวเองอยู่แล้วที่ Asset Request
 *   - CANCELLED บัญชีปิดถาวรแล้วว่าจะไม่เป็นสินทรัพย์
 */
export async function findInventory(input: InventoryListInput): Promise<Paginated<InventoryItem>> {
  const { page, limit } = input;
  const search = input.search?.trim();

  // ค้นสามช่องพร้อมกัน — คนจำได้ไม่เหมือนกัน บางคนจำเลขทะเบียน บางคนจำแต่ชื่อของ
  // บางคนมีแต่เลขเครื่องที่อ่านจากตัวสติกเกอร์บนเครื่อง
  const searchFilter: SQL | undefined = search
    ? or(
        ilike(asset.assetNumber, `%${search}%`),
        ilike(asset.description, `%${search}%`),
        ilike(asset.serialNumber, `%${search}%`),
      )
    : undefined;

  /**
   * มูลค่าคงเหลือ — คิดสดตอนคิวรี ไม่มีคอลัมน์เก็บไว้
   *
   * ★ ช่องไหนเป็น NULL ผลลัพธ์เป็น NULL แล้วการเทียบทุกแบบให้ NULL ซึ่งไม่ผ่าน WHERE
   *   แปลว่าชิ้นที่ SAP ให้ตัวเลขมาไม่ครบจะหลุดออกจากผลเองโดยไม่ต้องเขียนเงื่อนไขเพิ่ม
   *   — ตั้งใจให้เป็นแบบนั้น เพราะ "อยู่ในช่วง 0–5000" ตอบไม่ได้ถ้าไม่รู้ว่าเท่าไร
   */
  const netBookValue = sql`(${assetAccounting.bookedCost} - ${assetAccounting.accumulatedDepreciation})`;

  const where = and(
    isNull(asset.deletedAt),
    eq(asset.lifecycle, 'REGISTERED'),
    input.departmentId ? eq(asset.departmentId, input.departmentId) : undefined,
    input.companyCode ? eq(asset.companyCode, input.companyCode) : undefined,
    input.locationId ? eq(asset.locationId, input.locationId) : undefined,
    input.status ? eq(asset.status, input.status) : undefined,
    input.fiscalYear ? eq(assetAccounting.fiscalYear, input.fiscalYear) : undefined,
    input.minNetBookValue === undefined
      ? undefined
      : sql`${netBookValue} >= ${input.minNetBookValue}`,
    input.maxNetBookValue === undefined
      ? undefined
      : sql`${netBookValue} <= ${input.maxNetBookValue}`,
    searchFilter,
  );

  // นับกับดึงพร้อมกัน — total ต้องเป็นยอดของ "ทั้งชุดที่กรองแล้ว" ไม่ใช่จำนวนแถวในหน้านี้
  const [rows, totalResult] = await Promise.all([
    db
      .select({
        id: asset.id,
        companyCode: asset.companyCode,
        assetNumber: asset.assetNumber,
        description: asset.description,
        serialNumber: asset.serialNumber,
        imageId: asset.imageId,
        status: asset.status,
        acquisitionDate: asset.acquisitionDate,
        categoryName: category.name,
        departmentName: department.name,
        locationName: assetLocation.name,
        subLocation: {
          id: assetSubLocation.id,
          floor: assetSubLocation.floor,
          room: assetSubLocation.room,
          remark: assetSubLocation.remark,
        },
        holder: {
          id: employee.id,
          firstName: employee.firstName,
          lastName: employee.lastName,
          firstNameEn: employee.firstNameEn,
          lastNameEn: employee.lastNameEn,
          empId: employee.empId,
        },
        accounting: {
          fiscalYear: assetAccounting.fiscalYear,
          bookedCost: assetAccounting.bookedCost,
          accumulatedDepreciation: assetAccounting.accumulatedDepreciation,
        },
      })
      .from(asset)
      .leftJoin(category, eq(category.id, asset.categoryId))
      .leftJoin(department, eq(department.id, asset.departmentId))
      .innerJoin(assetLocation, eq(assetLocation.id, asset.locationId))
      .leftJoin(assetSubLocation, eq(assetSubLocation.id, asset.subLocationId))
      .leftJoin(employee, eq(employee.id, asset.employeeId))
      .leftJoin(assetAccounting, eq(assetAccounting.assetId, asset.id))
      .where(where)
      // ★ ต้องมี id ปิดท้ายเสมอ — เลขสินทรัพย์ซ้ำกันไม่ได้ก็จริง แต่ถ้าวันหลังมีคนเปลี่ยน
      //   คอลัมน์ที่เรียง แถวที่ค่าเท่ากันจะสลับตำแหน่งข้ามหน้า แล้วผู้ใช้จะเห็นชิ้นเดิมซ้ำ
      //   ในหน้าถัดไปและมีบางชิ้นหายไปเลยโดยไม่มีอะไรฟ้อง
      .orderBy(asc(asset.assetNumber), asc(asset.id))
      .limit(limit)
      .offset((page - 1) * limit),
    // ★ ต้อง join assetAccounting ด้วย ไม่ใช่ .from(asset) เปล่า ๆ — where เดียวกันนี้
    //   อ้างถึงคอลัมน์ของตารางบัญชี (fiscalYear / มูลค่าคงเหลือ) ถ้าไม่ join คิวรีนับจะพัง
    //   ทันทีที่มีคนใช้ตัวกรองสองตัวนั้น ส่วนคิวรีดึงแถวยังทำงานปกติ = เพจไม่มา แต่ตารางมา
    //   join นี้ไม่ทำให้แถวซ้ำ เพราะ asset_accounting มี assetId เป็น primary key (1:1)
    db
      .select({ value: count() })
      .from(asset)
      .leftJoin(assetAccounting, eq(assetAccounting.assetId, asset.id))
      .where(where),
  ]);

  const data = rows.map(
    (r): InventoryItem => ({
      id: r.id,
      companyCode: r.companyCode,
      // ck_asset_registered_needs_number บังคับไว้แล้วว่า REGISTERED ต้องมีเลข
      // — ที่นี่แค่ปลดชนิด null ให้ตรงกับความจริงที่ DB การันตี
      assetNumber: r.assetNumber ?? '',
      description: r.description,
      serialNumber: r.serialNumber,
      imageId: r.imageId,
      categoryName: r.categoryName,
      departmentName: r.departmentName,
      locationName: r.locationName,
      subLocationName: r.subLocation?.id ? subLocationName(r.subLocation) : null,
      // ประกอบชื่อฝั่งนี้เหมือนทุกหน้า — กติกา fallback ไทย/อังกฤษ/รหัส ต้องเป็นชุดเดียวกัน
      holderName: r.holder?.id ? employeeName(r.holder) : null,
      status: r.status,
      acquisitionDate: r.acquisitionDate,
      accounting: toInventoryAccounting(r.accounting),
    }),
  );

  return paginate(data, requireScalar(totalResult, 'count inventory'), page, limit);
}

/**
 * LEFT JOIN ที่ไม่เจอคู่ → drizzle คืนก้อนนี้เป็น null ทั้งก้อน (เช็คที่ตัวก้อนได้เลย)
 *
 * netBookValue = ราคาทุน − ค่าเสื่อมสะสม ขาดตัวใดตัวหนึ่ง = ตอบไม่ได้ ต้องเป็น null
 * ห้ามเดาเป็น 0 — 0 แปลว่า "ตัดค่าเสื่อมหมดแล้ว" ซึ่งคนละเรื่องกับ "ไม่รู้"
 * (กติกาเดียวกับ toMyAssetAccounting ข้างบน)
 */
function toInventoryAccounting(
  a: { fiscalYear: number; bookedCost: number | null; accumulatedDepreciation: number | null } | null,
) {
  if (a === null) return null;
  return {
    fiscalYear: a.fiscalYear,
    netBookValue:
      a.bookedCost === null || a.accumulatedDepreciation === null
        ? null
        : a.bookedCost - a.accumulatedDepreciation,
  };
}
