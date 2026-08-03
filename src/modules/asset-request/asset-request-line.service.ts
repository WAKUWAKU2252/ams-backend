// ═══ asset-request-line.service.ts — "รอบนี้จะขึ้นทะเบียนกี่ชิ้น" ═══
//
// กติกาเดียวของทั้งระบบหลังจากนี้:
//   จำนวนชิ้นที่ลงได้ของรอบ = declaredQty ถ้ามีคนแจ้งไว้ / ไม่มีก็ receivedQty ตาม SAP
//
// ใช้กับ PO งานเหมาที่หน่วยนับไม่ใช่ชิ้น (รับ "1 งาน" ที่ข้างในเป็นกล้อง 11 + NVR 1)
// ซึ่งเอา receivedQty มาเป็นเพดานตรง ๆ ไม่ได้เพราะเป็นคนละหน่วย

import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../../db';
import { asset, assetRequest, assetRequestLine, grpoLine } from '../../db/schema';
import { BadRequestError, ConflictError, NotFoundError } from '../../common/errors';
import * as presence from './presence.service';

const EDITABLE_STATUSES = ['DRAFT', 'REJECTED'];

/**
 * ด่านเดียวกันสำหรับทุกการแก้ไขในใบคำขอ: ใบต้องยังแก้ได้ และคนที่แก้ต้องถือ lock อยู่จริง
 * lock มาจาก registry in-memory (presence) — ต้องเปิดสาย presence อยู่ = เป็น holder ถึงจะแก้ได้
 */
export async function assertEditableBy(requestId: number, userId: number) {
  const req = await db.query.assetRequest.findFirst({
    where: and(eq(assetRequest.id, requestId), isNull(assetRequest.deletedAt)),
  });
  if (!req) throw new NotFoundError(`Asset request ${requestId}`);
  if (!EDITABLE_STATUSES.includes(req.status)) {
    throw new ConflictError(`คำขอนี้อยู่สถานะ ${req.status} แล้ว แก้ไขได้เฉพาะ DRAFT หรือ REJECTED`);
  }

  if (!presence.isHolder(requestId, userId)) {
    throw new ConflictError('คำขอนี้กำลังถูกผู้อื่นแก้ไขอยู่ หรือหน้านี้ยังไม่ได้เปิดโหมดแก้ไข');
  }

  return req;
}

/** รอบรับของต้องเป็นของ PO ใบเดียวกับคำขอ ไม่งั้นยอดของสอง PO เพี้ยนพร้อมกัน */
async function requireLineOfRequest(requestId: number, grpoLineId: string, poNumber: string) {
  const line = await db.query.grpoLine.findFirst({
    where: eq(grpoLine.id, grpoLineId),
    with: { poItem: true, grpo: true },
  });
  if (!line) throw new NotFoundError(`GRPO line ${grpoLineId}`);
  if (line.poItem.poNumber !== poNumber) {
    throw new BadRequestError(`รอบรับของนี้เป็นของ PO ${line.poItem.poNumber} ไม่ใช่ ${poNumber}`);
  }
  return line;
}

async function countRegistered(grpoLineId: string) {
  const [{ value }] = await db
    .select({ value: count() })
    .from(asset)
    .where(and(eq(asset.grpoLineId, grpoLineId), isNull(asset.deletedAt)));
  return value;
}

// แตะ updatedAt ของใบทุกครั้ง — เป็นทั้งตัวตัดสิน draft ร้าง และฐานของ optimistic check ตอน submit
async function touchRequest(requestId: number) {
  await db.update(assetRequest).set({ updatedAt: sql`now()` }).where(eq(assetRequest.id, requestId));
}

/**
 * แจ้ง/แก้จำนวนชิ้นของรอบรับของหนึ่งรอบ (1 รอบต่อ 1 คำขอ มีได้แถวเดียว — แจ้งซ้ำ = แก้ของเดิม)
 * declaredQty = 0 ได้ หมายถึง "รอบนี้ไม่เกิดสินทรัพย์" (เช่นของที่รับมาเป็นค่าบริการ)
 */
export async function declareLine(
  requestId: number,
  grpoLineId: string,
  declaredQty: number,
  reason: string,
  userId: number,
) {
  const req = await assertEditableBy(requestId, userId);
  const line = await requireLineOfRequest(requestId, grpoLineId, req.poNumber);

  // ลดจำนวนต่ำกว่าที่ลงทะเบียนไปแล้วในรอบนั้น = ข้อมูลที่กรอกไปแล้วจะเกินเพดานทันที
  // ต้องให้ผู้ใช้ลบชิ้นที่เกินเองก่อน ห้ามตัดหายเงียบ
  const registered = await countRegistered(grpoLineId);
  if (declaredQty < registered) {
    throw new BadRequestError(
      `GRPO ${line.grpo.grpoNo} ลงทะเบียนไปแล้ว ${registered} ชิ้น ไม่สามารถลดเหลือ ${declaredQty} ได้ `,
    );
  }

  // แจ้งจำนวน "เท่ากับที่ SAP รับมาเป๊ะ" = ไม่ได้แตกรายการ (จำนวนช่องเท่าเดิม) → ถือว่าไม่แจ้ง
  // ลบการแจ้งที่อาจค้างอยู่ทิ้ง กัน badge "แจ้งเอง/แตกรายการเอง" ขึ้นทั้งที่จำนวนไม่ต่างจาก SAP
  // (registered > receivedQty โดนด่านข้างบนดักไปแล้ว เพราะ declaredQty = receivedQty < registered)
  if (declaredQty === line.receivedQty) {
    const deleted = await db
      .delete(assetRequestLine)
      .where(and(eq(assetRequestLine.requestId, requestId), eq(assetRequestLine.grpoLineId, grpoLineId)))
      .returning();
    if (deleted.length > 0) await touchRequest(requestId); // แตะ updatedAt เฉพาะตอนมีการเปลี่ยนจริง
    return deleted[0] ?? null;
  }

  const [row] = await db
    .insert(assetRequestLine)
    .values({ requestId, grpoLineId, declaredQty, reason, createdBy: userId, updatedBy: userId })
    .onConflictDoUpdate({
      target: [assetRequestLine.requestId, assetRequestLine.grpoLineId],
      set: { declaredQty, reason, updatedBy: userId, updatedAt: sql`now()` },
    })
    .returning();

  await touchRequest(requestId);
  return row;
}

/** ยกเลิกการแจ้ง — กลับไปใช้ receivedQty ของ SAP ตามเดิม */
export async function removeDeclaredLine(requestId: number, grpoLineId: string, userId: number) {
  const req = await assertEditableBy(requestId, userId);
  const line = await requireLineOfRequest(requestId, grpoLineId, req.poNumber);

  // กลับไปใช้ตัวเลข SAP แล้วของที่ลงไปแล้วต้องไม่เกินเพดานเดิม ไม่งั้นใบจะอยู่ในสภาพที่ผิดกติกา
  const registered = await countRegistered(grpoLineId);
  if (registered > line.receivedQty) {
    throw new BadRequestError(
      `ยกเลิกการแจ้งไม่ได้ — รอบ ${line.grpo.grpoNo} ลงทะเบียนไว้ ${registered} ชิ้น แต่ SAP รับมา ${line.receivedQty}`,
    );
  }

  const deleted = await db
    .delete(assetRequestLine)
    .where(and(eq(assetRequestLine.requestId, requestId), eq(assetRequestLine.grpoLineId, grpoLineId)))
    .returning();
  if (deleted.length === 0) throw new NotFoundError(`การแจ้งจำนวนของรอบ ${line.grpo.grpoNo}`);

  await touchRequest(requestId);
  return { success: true };
}

/** map ของรอบที่ถูกแจ้งไว้ในใบนี้ — ใช้ตัดสินเพดานและเรนเดอร์ช่อง */
export async function declaredMap(requestId: number) {
  const rows = await db.query.assetRequestLine.findMany({
    where: eq(assetRequestLine.requestId, requestId),
  });
  return new Map(rows.map((r) => [r.grpoLineId, r]));
}
