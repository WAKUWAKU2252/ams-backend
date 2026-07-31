import { and, count, desc, eq, getTableColumns, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  asset,
  assetRequest,
  assetRequestLine,
  assetRequestOpener,
  grpoLine,
  purchaseOrder,
  purchaseOrderItem,
  user,
} from '../../db/schema';
import { ConflictError, NotFoundError } from '../../common/errors';
import { paginate } from '../../common/pagination';
import { COST_TOLERANCE } from '../asset/asset.service';
import { listQuery } from './asset-request.schema';

type ListQuery = typeof listQuery.static;

const EDITABLE_STATUSES = ['DRAFT', 'REJECTED'] as const;
const TERMINAL_STATUSES = ['REGISTERED', 'CANCELLED'] as const;

function isEditableStatus(status: string): boolean {
  return (EDITABLE_STATUSES as readonly string[]).includes(status);
}
export async function createDraft(poNumber: string, userId: number) {
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
    const [inserted] = await db
      .insert(assetRequest)
      .values({ poNumber, createdBy: userId })
      .returning();
    return { requestId: inserted.id, reused: false };
  } catch (error) {
    const isUniqueViolation =
      typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
    if (isUniqueViolation) {
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

  // lock ไม่อยู่ที่ DB แล้ว — สถานะ lock จริงมาจากสาย presence (registry in-memory) ที่ frontend เปิดเอง
  return request;
}

export async function listMyDrafts(userId: number, { page, limit, status }: ListQuery) {
  const conditions = [eq(assetRequestOpener.userId, userId), isNull(assetRequest.deletedAt)];
  if (status && status.length) conditions.push(inArray(assetRequest.status, status));
  const where = and(...conditions);

  const [rows, totalResult] = await Promise.all([
    db
      // createdBy เป็น id — join user มาแสดงชื่อในลิสต์ (createdBy คงไว้เป็น audit)
      .select({
        ...getTableColumns(assetRequest),
        createdByName: user.displayName,
        requesterName: purchaseOrder.requesterName,
        assetCount: sql<number>`(
          select count(*) from ${asset}
          where ${asset.requestId} = ${assetRequest.id} and ${asset.deletedAt} is null
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

  return paginate(rows, totalResult[0].value, page, limit);
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
  const rows = await db
    .select({
      poItemId: asset.poItemId,
      unitNo: asset.unitNo,
      serialNumber: asset.serialNumber,
      acquisitionCost: asset.acquisitionCost,
    })
    .from(asset)
    .where(and(eq(asset.requestId, requestId), isNull(asset.deletedAt)));

  if (rows.length === 0) {
    throw new ConflictError('ยังไม่มีรายการสินทรัพย์ในคำขอนี้ — กรอกอย่างน้อย 1 ชิ้นก่อนส่ง');
  }

  // S/N คือตัวระบุกล่องจริง ถ้าปล่อยว่างผ่านไปได้ Audit จะแยกชิ้นที่เหมือนกันไม่ออกตลอดอายุสินทรัพย์
  const missingSerial = rows.filter((r) => !r.serialNumber?.trim());
  if (missingSerial.length > 0) {
    throw new ConflictError(
      `ยังไม่ได้กรอก Serial number ${missingSerial.length} ชิ้น (ชิ้นที่ ${missingSerial
        .map((r) => r.unitNo)
        .join(', ')}) — กรอกให้ครบก่อนส่ง`,
    );
  }

  // ยอดเงินต่อบรรทัดเกินที่ PO ระบุ = ยอมได้ (ค่าติดตั้ง/ขนส่งที่รวมเป็นทุน) แต่ต้องมีคนอธิบายไว้
  // ที่ใดที่หนึ่งของบรรทัดนั้น มิฉะนั้น manager จะเห็นแค่ตัวเลขเกินโดยไม่รู้เหตุผล
  const items = await db
    .select({
      id: purchaseOrderItem.id,
      description: purchaseOrderItem.itemDescription,
      quantity: purchaseOrderItem.quantity,
      lineTotal: purchaseOrderItem.lineTotal,
    })
    .from(purchaseOrderItem)
    .where(eq(purchaseOrderItem.poNumber, poNumber));

  const declaredItemIds = new Set(
    (
      await db
        .select({ poItemId: grpoLine.poItemId })
        .from(assetRequestLine)
        .innerJoin(grpoLine, eq(grpoLine.id, assetRequestLine.grpoLineId))
        .where(eq(assetRequestLine.requestId, requestId))
    ).map((r) => r.poItemId),
  );

  for (const item of items) {
    const sum = rows
      .filter((r) => r.poItemId === item.id)
      .reduce((total, r) => total + r.acquisitionCost, 0);
    const lineAmount = item.lineTotal?? 0;
    if (sum > lineAmount + COST_TOLERANCE && !declaredItemIds.has(item.id)) {
      throw new ConflictError(
        `"${item.description}" กรอกราคารวม ${sum.toLocaleString()} เกินยอดใน PO (${lineAmount.toLocaleString()}) ` +
          `— ต้องระบุเหตุผลที่รอบรับของของรายการนี้ก่อนส่ง`,
      );
    }
  }
}

export async function submitRequest(id: number, expectedUpdatedAt: string) {
  const req = await requireRequest(id);
  if (!isEditableStatus(req.status)) {
    throw new ConflictError('ส่งได้เฉพาะคำขอสถานะ DRAFT หรือ REJECTED เท่านั้น');
  }
  await assertSubmittable(req.id, req.poNumber);
  if (req.updatedAt !== expectedUpdatedAt) {
    throw new ConflictError('คำขอถูกแก้ไขโดยผู้อื่นแล้ว กรุณาโหลดใหม่');
  }

  const [row] = await db
    .update(assetRequest)
    .set({ status: 'PENDING_APPROVAL', submittedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(assetRequest.id, id), inArray(assetRequest.status, [...EDITABLE_STATUSES])))
    .returning({ id: assetRequest.id, status: assetRequest.status });
  if (!row) throw new ConflictError('คำขอเพิ่งถูกเปลี่ยนสถานะ กรุณาโหลดใหม่');
  return row;
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
  return row;
}

// reject — manager ตีกลับ พร้อมเหตุผล → REJECTED (กลับมาแก้ได้เหมือน DRAFT)
export async function rejectRequest(id: number, managerId: number, reason: string) {
  const req = await requireRequest(id);
  if (req.status !== 'PENDING_APPROVAL') {
    throw new ConflictError('ตีกลับได้เฉพาะคำขอที่รออนุมัติ');
  }
  const [row] = await db
    .update(assetRequest)
    .set({ status: 'REJECTED', rejectedBy: managerId, rejectedAt: sql`now()`, rejectReason: reason, updatedAt: sql`now()` })
    .where(and(eq(assetRequest.id, id), eq(assetRequest.status, 'PENDING_APPROVAL')))
    .returning({ id: assetRequest.id, status: assetRequest.status });
  if (!row) throw new ConflictError('คำขอเพิ่งถูกเปลี่ยนสถานะ');
  return row;
}
