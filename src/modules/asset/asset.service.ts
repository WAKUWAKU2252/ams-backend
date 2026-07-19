// ═══ asset.service.ts — สมองของ module ═══
// กฎเหล็กเดิม: TypeScript ล้วน ห้าม import จาก 'elysia' / ห้าม any / error โยน AppError
//
// [วิธีคิดของ create — ลำดับการตรวจคือการเล่าเหตุผลทางธุรกิจ]
//   Q1 ใบคำขอมีจริงและยังแก้ได้ไหม      (DRAFT เท่านั้น)          → 404 / 400
//   Q2 รอบรับของที่อ้างเป็นของ PO ใบนี้จริงไหม                    → 400  ★ กันยัดของข้าม PO
//   Q3 ราคาถึงเกณฑ์สินทรัพย์ไหม          (> 5,000 ต่อหน่วย)        → 400
//   Q4 ยังลงได้อีกไหม                   (ไม่เกินที่รับจริง/ที่สั่ง)  → 400
//   Q5 ข้อมูลอ้างอิงที่เลือกใช้ได้จริงไหม (master ยัง active)      → 400
//   Q6 รูปที่แนบเป็นรูปจริงและยังว่างไหม                          → 400 / 409
// ทุก error ต้องบอกสิ่งที่ผู้ใช้ "แก้ได้" ไม่ใช่แค่ว่า invalid

import { and, count, eq, inArray, isNull, max } from 'drizzle-orm';
import { db } from '../../db';
import {
  asset,
  assetRequest,
  grpoLine,
  attachment,
  category,
  uom,
  assetLocation,
  assetSubLocation,
  employee,
} from '../../db/schema';
import { NotFoundError, BadRequestError, ConflictError } from '../../common/errors';
import { ASSET_MIN_UNIT_PRICE, isRegistrable } from '../../common/asset-policy';
import { createAssetBody, updateAssetBody } from './asset.schema';

type CreateBody = typeof createAssetBody.static;
type UpdateBody = typeof updateAssetBody.static;

// เกณฑ์ราคาอยู่ที่ common/asset-policy — เช็คที่ service ด้วยไม่ใช่แค่ front
// เพราะหน้าเว็บ disable ปุ่มได้ก็จริง แต่ยิง API ตรงยังผ่าน

// ── ตัวช่วยที่ใช้ร่วมกันระหว่าง create กับ update ─────────────────────────────

/** master ที่เลือกต้องมีจริงและยัง active — ปิดใช้แล้วห้ามเลือกใหม่ แต่ของเก่าที่ชี้อยู่ไม่กระทบ */
async function assertMasterUsable(input: {
  categoryId?: number;
  uomId?: number;
  locationId?: number;
  subLocationId?: number | null;
  employeeId?: number | null;
}) {
  if (input.categoryId !== undefined) {
    const row = await db.query.category.findFirst({ where: eq(category.id, input.categoryId) });
    if (!row) throw new BadRequestError(`ไม่พบหมวดหมู่ id ${input.categoryId}`);
    if (!row.isActive) throw new BadRequestError(`หมวดหมู่ "${row.name}" ถูกปิดใช้งานแล้ว`);
  }

  if (input.uomId !== undefined) {
    const row = await db.query.uom.findFirst({ where: eq(uom.id, input.uomId) });
    if (!row) throw new BadRequestError(`ไม่พบหน่วยนับ id ${input.uomId}`);
    if (!row.isActive) throw new BadRequestError(`หน่วยนับ "${row.name}" ถูกปิดใช้งานแล้ว`);
  }

  if (input.employeeId != null) {
    const row = await db.query.employee.findFirst({ where: eq(employee.id, input.employeeId) });
    if (!row) throw new BadRequestError(`ไม่พบพนักงานรหัส ${input.employeeId}`);
    if (!row.isActive) throw new BadRequestError(`พนักงาน "${row.name}" ไม่ได้ทำงานแล้ว`);
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
    throw new ConflictError(`รูปนี้ถูกใช้กับสินทรัพย์ชิ้นอื่นแล้ว (unit ${used.unitNo})`);
  }
}

// ── create ───────────────────────────────────────────────────────────────────

export async function create(body: CreateBody) {
  // [Q1] ใบคำขอมีจริงและยังแก้ได้ไหม
  const request = await db.query.assetRequest.findFirst({
    where: and(eq(assetRequest.id, body.requestId), isNull(assetRequest.deletedAt)),
  });
  if (!request) throw new NotFoundError(`Asset request ${body.requestId}`);
  if (request.status !== 'DRAFT') {
    throw new BadRequestError(
      `คำขอนี้อยู่สถานะ ${request.status} แล้ว แก้ไขรายการได้เฉพาะตอนเป็น DRAFT`,
    );
  }

  // [Q2] รอบรับของที่อ้างเป็นของ PO ใบนี้จริงไหม
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

  // [Q3] ของชิ้นนี้เข้าเกณฑ์สินทรัพย์ไหม — ต่ำกว่าเกณฑ์ลงบัญชีเป็นค่าใช้จ่าย ไม่ขึ้นทะเบียน
  if (!isRegistrable(line.poItem.unitPrice)) {
    throw new BadRequestError(
      `"${line.poItem.itemDescription}" ราคาต่อหน่วย ${line.poItem.unitPrice.toLocaleString()} บาท ` +
        `ไม่ถึงเกณฑ์สินทรัพย์ (มากกว่า ${ASSET_MIN_UNIT_PRICE.toLocaleString()} บาท) — ลงเป็นค่าใช้จ่ายแทน`,
    );
  }

  // [Q4] ยังลงได้อีกไหม — สองเพดานคนละความหมาย ต้องเช็คทั้งคู่
  //   ต่อรอบรับของ: ห้ามเกินที่ "รับมาจริง" ในรอบนั้น (ของยังมาไม่ถึงลงทะเบียนไม่ได้)
  const [{ value: inThisLine }] = await db
    .select({ value: count() })
    .from(asset)
    .where(and(eq(asset.grpoLineId, body.grpoLineId), isNull(asset.deletedAt)));
  if (inThisLine >= line.receivedQty) {
    throw new BadRequestError(
      `รอบ ${line.grpo.grpoNo} รับ "${line.poItem.itemDescription}" มา ${line.receivedQty} ชิ้น ` +
        `และลงทะเบียนครบแล้ว — ส่วนที่เหลือต้องรอรอบรับของถัดไป`,
    );
  }

  //   ต่อ PO line: ห้ามเกินที่ "สั่ง" ทั้งใบ (กันกรณีรับเกินสั่งแล้วลงทะเบียนตามไปด้วย)
  const linesOfItem = await db
    .select({ id: grpoLine.id })
    .from(grpoLine)
    .where(eq(grpoLine.poItemId, line.poItemId));
  const [{ value: inThisItem }] = await db
    .select({ value: count() })
    .from(asset)
    .where(
      and(
        inArray(
          asset.grpoLineId,
          linesOfItem.map((l) => l.id),
        ),
        isNull(asset.deletedAt),
      ),
    );
  if (inThisItem >= line.poItem.quantity) {
    throw new BadRequestError(
      `"${line.poItem.itemDescription}" สั่งไว้ ${line.poItem.quantity} ชิ้น ลงทะเบียนครบแล้ว`,
    );
  }

  // [Q5] [Q6] ข้อมูลอ้างอิงและรูป
  await assertMasterUsable(body);
  if (body.imageId) await assertImageUsable(body.imageId);

  // unitNo ออกให้เอง ไม่รับจาก client — ถ้าให้ client ส่ง สองคนกรอกพร้อมกันจะชนเลขเดียวกัน
  // (uq_asset_unit จะเป็นด่านสุดท้ายที่จับได้ แต่ผู้ใช้จะเจอ error โดยไม่เข้าใจว่าทำอะไรผิด)
  const [{ value: lastUnit }] = await db
    .select({ value: max(asset.unitNo) })
    .from(asset)
    .where(eq(asset.requestId, body.requestId));

  const [row] = await db
    .insert(asset)
    .values({
      requestId: body.requestId,
      unitNo: (lastUnit ?? 0) + 1,
      grpoLineId: body.grpoLineId,
      description: body.description ?? line.poItem.itemDescription,
      serialNumber: body.serialNumber,
      assetClass: body.assetClass,
      categoryId: body.categoryId,
      uomId: body.uomId,
      locationId: body.locationId,
      subLocationId: body.subLocationId,
      employeeId: body.employeeId,
      warrantyStartDate: body.warrantyStartDate,
      warrantyEndDate: body.warrantyEndDate,
      imageId: body.imageId,
      createdBy: body.createdBy,
      updatedBy: body.createdBy,
    })
    .returning();

  return row;
}

// ── read ─────────────────────────────────────────────────────────────────────

export async function findOneOrFail(id: number) {
  const row = await db.query.asset.findFirst({
    where: and(eq(asset.id, id), isNull(asset.deletedAt)),
    with: {
      grpoLine: { with: { grpo: true, poItem: true } },
      category: true,
      uom: true,
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
 * รายการ "ช่อง" ที่หน้าฟอร์มต้องเรนเดอร์ — ตัวเลขสองตัวคนละหน้าที่:
 *   po_item.quantity   = จะมีทั้งหมดกี่ชิ้น -> จำนวนช่องที่แสดง (คงที่ตั้งแต่เปิดใบ)
 *   Σ receivedQty      = ตอนนี้ของมาถึงแล้วกี่ชิ้น -> เส้นแบ่งว่าช่องไหนเปิดให้กรอก
 *
 * สถานะต่อช่อง (เรียงตามลำดับที่ตรวจ):
 *   registered  มีแถวใน asset แล้ว
 *   lowValue    ราคาต่อหน่วยไม่ถึงเกณฑ์ — แสดงให้เห็นว่ามีของ แต่กรอกไม่ได้ทั้ง line
 *   pending     ของมาถึงแล้วและยังไม่ได้ลง -> กรอกได้
 *   noGrpo      ของยังมาไม่ถึง
 * lowValue มาก่อน pending/noGrpo เพราะไม่ว่าของจะมาหรือไม่ ก็ลงทะเบียนไม่ได้อยู่ดี
 */
export async function findSlotsByRequest(requestId: number) {
  const request = await db.query.assetRequest.findFirst({
    where: and(eq(assetRequest.id, requestId), isNull(assetRequest.deletedAt)),
    with: {
      purchaseOrder: {
        with: {
          items: {
            orderBy: (item, { asc }) => [asc(item.poLine)],
            with: { grpoLines: { with: { grpo: true }, orderBy: (l, { asc }) => [asc(l.grpoId)] } },
          },
        },
      },
    },
  });
  if (!request) throw new NotFoundError(`Asset request ${requestId}`);

  const registered = await db.query.asset.findMany({
    where: and(eq(asset.requestId, requestId), isNull(asset.deletedAt)),
    with: { grpoLine: { with: { grpo: true } } },
    orderBy: (a, { asc }) => [asc(a.unitNo)],
  });

  return {
    requestId,
    poNumber: request.poNumber,
    status: request.status,
    items: request.purchaseOrder.items.map((item) => {
      const received = item.grpoLines.reduce((sum, l) => sum + l.receivedQty, 0);
      const mine = registered.filter((a) => item.grpoLines.some((l) => l.id === a.grpoLineId));
      const isLowValue = !isRegistrable(item.unitPrice);

      const slots = Array.from({ length: item.quantity }, (_, i) => {
        const existing = mine[i];
        if (existing) {
          return {
            index: i + 1,
            status: 'registered' as const,
            assetId: existing.id,
            unitNo: existing.unitNo,
            serialNumber: existing.serialNumber,
            grpoNo: existing.grpoLine.grpo.grpoNo,
          };
        }
        // ราคาไม่ถึงเกณฑ์ = ลงไม่ได้ทั้ง line ไม่ว่าของจะมาถึงหรือยัง
        if (isLowValue) return { index: i + 1, status: 'lowValue' as const };
        // ของที่รับมาแล้วแต่ยังไม่ได้ลงทะเบียน = ช่องที่เปิดให้กรอก
        return i < received
          ? { index: i + 1, status: 'pending' as const }
          : { index: i + 1, status: 'noGrpo' as const };
      });

      return {
        poItemId: item.id,
        poLine: item.poLine,
        itemDescription: item.itemDescription,
        unitPrice: item.unitPrice,
        // บอก frontend ตรง ๆ ว่าทั้ง line นี้ลงไม่ได้ จะได้ไม่ต้องเดาจากราคาเอง
        isLowValue,
        ordered: item.quantity,
        received,
        registered: mine.length,
        // ช่อง pending ต้องรู้ว่าจะผูกกับรอบไหน — เอา line ที่ยังลงไม่เต็มรอบแรกสุด
        grpoLines: item.grpoLines.map((l) => ({
          id: l.id,
          grpoNo: l.grpo.grpoNo,
          grpoDate: l.grpo.grpoDate,
          receivedQty: l.receivedQty,
          registered: registered.filter((a) => a.grpoLineId === l.id).length,
        })),
        slots,
      };
    }),
  };
}

// ── update / delete ──────────────────────────────────────────────────────────

export async function update(id: number, body: UpdateBody) {
  const current = await db.query.asset.findFirst({
    where: and(eq(asset.id, id), isNull(asset.deletedAt)),
    with: { request: true },
  });
  if (!current) throw new NotFoundError(`Asset ${id}`);
  if (current.request.status !== 'DRAFT') {
    throw new BadRequestError(
      `คำขอนี้อยู่สถานะ ${current.request.status} แล้ว แก้ไขรายการได้เฉพาะตอนเป็น DRAFT`,
    );
  }

  await assertMasterUsable({
    ...body,
    // ถ้าแก้เฉพาะ subLocation ต้องเทียบกับ location เดิมที่ยังใช้อยู่ ไม่ใช่ปล่อยผ่าน
    locationId: body.locationId ?? current.locationId,
  });
  if (body.imageId) await assertImageUsable(body.imageId, id);

  const { updatedBy, ...fields } = body;
  const [row] = await db
    .update(asset)
    .set({ ...fields, updatedBy, updatedAt: sqlNow() })
    .where(eq(asset.id, id))
    .returning();

  return row;
}

export async function softDelete(id: number, deletedBy: string) {
  const current = await db.query.asset.findFirst({
    where: and(eq(asset.id, id), isNull(asset.deletedAt)),
    with: { request: true },
  });
  if (!current) throw new NotFoundError(`Asset ${id}`);
  if (current.request.status !== 'DRAFT') {
    throw new BadRequestError(
      `คำขอนี้อยู่สถานะ ${current.request.status} แล้ว ลบรายการได้เฉพาะตอนเป็น DRAFT`,
    );
  }

  // ไม่ลบไฟล์รูปที่ผูกอยู่ — ปล่อยให้ cleanupOrphans ตัดสินใจทีหลังว่ากำพร้าจริงไหม
  // (แถวนี้ถูก soft delete แล้วแต่ยังชี้ imageId อยู่ ไฟล์จึงยังไม่กำพร้า จนกว่าจะลบจริง)
  const [row] = await db
    .update(asset)
    .set({ deletedAt: sqlNow(), deletedBy })
    .where(eq(asset.id, id))
    .returning();

  return { success: true, id: row.id };
}

// เลี่ยง import sql ทั้งก้อนเพื่อใช้ now() ที่เดียว — เขียนเป็น helper ให้อ่านง่าย
function sqlNow() {
  return new Date().toISOString();
}
