import { and, count, eq, inArray, isNull, max } from 'drizzle-orm';
import { db } from '../../db';
import {
  asset,
  assetRequest,
  assetRequestLine,
  grpoLine,
  attachment,
  category,
  uom,
  assetLocation,
  assetSubLocation,
  employee,
} from '../../db/schema';
import { NotFoundError, BadRequestError, ConflictError } from '../../common/errors';
import { declaredMap } from '../asset-request/asset-request-line.service';
import { createAssetBody, updateAssetBody } from './asset.schema';

// เผื่อเศษจากการหารราคาแบ่งชิ้น (10,000 ÷ 3) — ต่างระดับสตางค์ไม่ถือว่าเกิน
export const COST_TOLERANCE = 1;

type CreateBody = typeof createAssetBody.static;
type UpdateBody = typeof updateAssetBody.static;
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
    throw new ConflictError(
      `รูปนี้ถูกใช้กับสินทรัพย์ชิ้นอื่นแล้ว (${used.serialNumber ?? `asset id ${used.id}`})`,
    );
  }
}

// ── create ───────────────────────────────────────────────────────────────────

export async function create(body: CreateBody, userId: number) {
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

  const [{ value: inThisLine }] = await db
    .select({ value: count() })
    .from(asset)
    .where(and(eq(asset.grpoLineId, body.grpoLineId), isNull(asset.deletedAt)));
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

  const [{ value: declaredOnItem }] = await db
    .select({ value: count() })
    .from(assetRequestLine)
    .where(
      and(
        eq(assetRequestLine.requestId, body.requestId),
        inArray(assetRequestLine.grpoLineId, idsOfItem),
      ),
    );

  if (declaredOnItem === 0) {
    const [{ value: inThisItem }] = await db
      .select({ value: count() })
      .from(asset)
      .where(and(inArray(asset.grpoLineId, idsOfItem), isNull(asset.deletedAt)));
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
  let unitNo = body.unitNo;
  if (unitNo === undefined) {
    const [{ value: maxUnitNo }] = await db
      .select({ value: max(asset.unitNo) })
      .from(asset)
      .where(and(eq(asset.poItemId, line.poItemId), isNull(asset.deletedAt)));
    unitNo = (maxUnitNo ?? 0) + 1;
  }

  const [row] = await insertAssetOrConflict({
      requestId: body.requestId,
      grpoLineId: body.grpoLineId,
      poItemId: line.poItemId,
      unitNo,
      // ราคาที่เสนอ — งานเหมาที่แตกเป็นหลายชิ้นต้องกรอกเอง เพราะราคาต่อชิ้นไม่เท่ากัน
      acquisitionCost: body.acquisitionCost ?? line.poItem.unitPrice,
      // ชิ้นนี้เกิดเพราะคนแจ้งจำนวนเอง ไม่ได้มาจากตัวเลข SAP — ตรึงไว้ตลอดอายุสินทรัพย์
      isSplitItem: declared != null,
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
      createdBy: userId,
      updatedBy: userId,
  });

  return row;
}

// ชนกันที่ unique (poItemId, unitNo) = มีคนคว้าเลขช่องนั้นไปก่อนเสี้ยววินาที — เป็นเคสปกติ
// ของการแย่งกัน ไม่ใช่บั๊ก จึงแปลงเป็น 409 ให้ผู้ใช้โหลดใหม่ แทนที่จะโผล่เป็น 500
async function insertAssetOrConflict(values: typeof asset.$inferInsert) {
  try {
    return await db.insert(asset).values(values).returning();
  } catch (error) {
    const isUniqueViolation =
      typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
    if (isUniqueViolation) {
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
 * สถานะต่อช่อง:
 *   registered  มีแถวใน asset แล้ว
 *   pending     ของมาถึงแล้วและยังไม่ได้ลง -> กรอกได้
 *   noGrpo      ของยังมาไม่ถึง
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

  // รอบไหนถูกแจ้งจำนวนเองไว้บ้าง — ตัวตัดสินว่าเรนเดอร์กี่ช่อง
  const declared = await declaredMap(requestId);

  return {
    requestId,
    poNumber: request.poNumber,
    status: request.status,
    items: request.purchaseOrder.items.map((item) => {
      const received = item.grpoLines.reduce((sum, l) => sum + l.receivedQty, 0);
      const capOf = (lineId: string, receivedQty: number) =>
        declared.get(lineId)?.declaredQty ?? receivedQty;
      const capTotal = item.grpoLines.reduce((sum, l) => sum + capOf(l.id, l.receivedQty), 0);
      const isDeclared = item.grpoLines.some((l) => declared.has(l.id));
      const planned = isDeclared ? capTotal : item.quantity;
      const mine = registered.filter((a) => item.grpoLines.some((l) => l.id === a.grpoLineId));
      const regByLine = new Map<string, number>();
      for (const a of mine) regByLine.set(a.grpoLineId, (regByLine.get(a.grpoLineId) ?? 0) + 1);

      const pendingQueue: { grpoLineId: string; grpoNo: string }[] = [];
      for (const l of item.grpoLines) {
        const remain = capOf(l.id, l.receivedQty) - (regByLine.get(l.id) ?? 0);
        for (let k = 0; k < remain; k++) {
          pendingQueue.push({ grpoLineId: l.id, grpoNo: l.grpo.grpoNo });
        }
      }
      let pendingPointer = 0;
      const slotCount = Math.max(planned, mine.length);

      const slots = Array.from({ length: slotCount }, (_, i) => {
        const existing = mine[i];
        if (existing) {
          return {
            index: i + 1,
            status: 'registered' as const,
            assetId: existing.id,
            serialNumber: existing.serialNumber,
            grpoLineId: existing.grpoLineId,
            grpoNo: existing.grpoLine.grpo.grpoNo,
          };
        }
        const alloc = pendingQueue[pendingPointer++];
        if (alloc) {
          return {
            index: i + 1,
            status: 'pending' as const,
            grpoLineId: alloc.grpoLineId,
            grpoNo: alloc.grpoNo,
          };
        }
        return { index: i + 1, status: 'noGrpo' as const };
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
          grpoNo: l.grpo.grpoNo,
          grpoDate: l.grpo.grpoDate,
          receivedQty: l.receivedQty,
          declaredQty: declared.get(l.id)?.declaredQty ?? null,
          declaredReason: declared.get(l.id)?.reason ?? null,
          registered: registered.filter((a) => a.grpoLineId === l.id).length,
        })),
        slots,
      };
    }),
  };
}

// ── update / delete ──────────────────────────────────────────────────────────

export async function update(id: number, body: UpdateBody, userId: number) {
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

  // ย้ายรอบรับของ: ต้องเป็นรอบของ PO line เดิม (composite FK กันไว้อีกชั้น) และรอบปลายทางต้องยังมีที่ว่าง
  if (body.grpoLineId && body.grpoLineId !== current.grpoLineId) {
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
    const [{ value: inTarget }] = await db
      .select({ value: count() })
      .from(asset)
      .where(and(eq(asset.grpoLineId, body.grpoLineId), isNull(asset.deletedAt)));
    if (inTarget >= capOfTarget) {
      throw new BadRequestError(`รอบ ${target.grpo.grpoNo} เต็มแล้ว (${capOfTarget} ชิ้น)`);
    }
  }

  const [row] = await db
    .update(asset)
    .set({ ...body, updatedBy: userId, updatedAt: sqlNow() })
    .where(eq(asset.id, id))
    .returning();

  return row;
}

export async function softDelete(id: number, userId: number) {
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
    .set({ deletedAt: sqlNow(), deletedBy: userId, updatedBy: userId, updatedAt: sqlNow() })
    .where(eq(asset.id, id))
    .returning();

  return { success: true, id: row.id };
}

// เลี่ยง import sql ทั้งก้อนเพื่อใช้ now() ที่เดียว — เขียนเป็น helper ให้อ่านง่าย
function sqlNow() {
  return new Date().toISOString();
}
