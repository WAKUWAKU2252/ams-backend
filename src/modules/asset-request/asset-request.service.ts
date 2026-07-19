// ═══ asset-request.service.ts — สมองของ module ═══
// กฎเหล็กเดิม: TypeScript ล้วน ห้าม import จาก 'elysia' / ห้าม any / error โยน AppError
//
// [วิธีคิดของ createDraft]
//   Q1 เป้าที่ชี้มีจริงไหม?                 (PO ใบนี้มีตัวตน)      → ไม่มี = 404
//   Q2 PO นี้มี draft ค้างอยู่แล้วหรือเปล่า?  (ใครสร้างไว้ก็ตาม)     → มี = คืนใบเดิมให้ทำต่อ
//
// จงใจไม่มีด่าน "ต้องรับของแล้วถึงเปิดใบได้" — เปิดดูได้เสมอ ของที่ยังไม่มาถึง
// จะขึ้นสถานะ noGrpo ให้เห็น แล้ว frontend เป็นคนกันไม่ให้กรอก

import { and, count, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { assetRequest, purchaseOrder } from '../../db/schema';
import { NotFoundError } from '../../common/errors';
import { paginate } from '../../common/pagination';
import { listQuery } from './asset-request.schema';

type ListQuery = typeof listQuery.static;

export async function createDraft(poNumber: string, createBy: string) {
  // [Q1] PO มีตัวตนไหม
  const po = await db.query.purchaseOrder.findFirst({
    where: eq(purchaseOrder.poNumber, poNumber),
    with: {
      items: {
        with: { grpoLines: true },
      },
    },
  });
  if (!po) {
    throw new NotFoundError(`Purchase order ${poNumber}`);
  }

  // จงใจ "ไม่" บล็อก PO ที่ยังไม่มีการรับของ — เปิดใบดูได้เสมอ ทุกแถวจะขึ้นสถานะ noGrpo
  // ให้เห็นว่ามีของอะไรรออยู่บ้าง แล้ว frontend เป็นคนกันไม่ให้กรอก
  // (ด่านจริงอยู่ที่ POST /assets ซึ่งต้องอ้าง grpoLineId ที่มีตัวตน — ไม่มีรอบรับของ
  //  ก็ไม่มี id ให้ส่ง สร้าง asset ไม่ได้อยู่ดี ไม่ว่าจะยิง API ตรงหรือผ่านหน้าจอ)
  //
  // โควตาต่อรายการเช็คตอน POST /assets ไม่ใช่ตอนสร้าง draft (draft ต้องหลวมไว้ก่อน)
  //
  // ★ สองตัวเลขคนละหน้าที่ อย่าสับสน:
  //   purchase_order_item.quantity  = "จะมีทั้งหมดกี่ชิ้น" -> จำนวนแถวที่หน้าฟอร์มแสดง (คงที่ตั้งแต่วันแรก)
  //   Σ grpo_line.receivedQty       = "ตอนนี้ของมาถึงแล้วกี่ชิ้น" -> เส้นแบ่งว่าแถวไหนเปิดให้กรอก
  //
  // ระบบไม่คัดกรองเองว่ารายการไหนควรขึ้นทะเบียน — Warehouse ลงได้ทุกรายการที่รับของแล้ว
  // แล้วบัญชีเป็นผู้ตรวจตอนอนุมัติ (เกณฑ์อัตโนมัติตัดสินผิดได้ เช่น ค่าเช่า cloud ราคาสูง
  // แต่เป็นค่าใช้จ่าย ส่วนของถูกบางอย่างกลับต้องติดตาม)

  // [Q3 — lock ระดับ PO] กติกาธุรกิจ: PO หนึ่งใบมี draft ค้างได้ใบเดียวทั้งระบบ
  // ใครกด Create ตอนมี draft ค้าง = รับใบเดิมไปทำต่อ (จงใจ "ไม่" กรอง createdBy)
  // เงื่อนไขต้องตรงกับ partial unique index uq_asset_request_draft เป๊ะ:
  // (poNumber) WHERE status='DRAFT' AND deleted_at IS NULL
  // (ขาด isNull(deletedAt) = ไปคืนใบที่ถูกลบแล้ว)
  const draftWhere = and(
    eq(assetRequest.poNumber, poNumber),
    eq(assetRequest.status, 'DRAFT'),
    isNull(assetRequest.deletedAt),
  );

  const existingDraft = await db.query.assetRequest.findFirst({ where: draftWhere });
  if (existingDraft) {
    return { requestId: existingDraft.id, reused: true };
  }

  // field อื่นไม่ต้องใส่ — status/createdAt/updatedAt ใช้ default ของ DB (default อยู่ที่ schema ที่เดียว)
  // การกันซ้ำมี 2 ชั้น: เช็คก่อน insert = กันเคสปกติ / partial unique index = กันเคสเบียด
  // ถ้าแพ้ race (รหัส 23505 unique_violation) อย่าโยน 500 — query ใบที่ "ชนะ" มาคืนแทน
  try {
    const [inserted] = await db
      .insert(assetRequest)
      .values({ poNumber, createdBy: createBy })
      .returning();
    return { requestId: inserted.id, reused: false };
  } catch (error) {
    const isUniqueViolation =
      typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
    if (isUniqueViolation) {
      const winner = await db.query.assetRequest.findFirst({ where: draftWhere });
      if (winner) {
        return { requestId: winner.id, reused: true };
      }
    }
    throw error;
  }
}

// พ่วง PO ทั้งใบมาเลยเพราะหน้าฟอร์มต้องคลี่ทุก line เป็นรายชิ้น (สั่ง/รับ/ลงแล้ว ต่อ line)
// — ดึงจบใน request เดียว ดีกว่าให้ front ยิงเพิ่มอีกรอบ
// (with ต้อง inline ในแต่ละ query ตามกติกา Drizzle ของโปรเจกต์ — แยก const แล้ว type หาย)
export async function getDraftOrFail(id: number) {
  const request = await db.query.assetRequest.findFirst({
    where: and(eq(assetRequest.id, id), isNull(assetRequest.deletedAt)),
    with: {
      purchaseOrder: {
        with: {
          items: {
            orderBy: (item, { asc }) => [asc(item.poLine)],
            // พ่วง grpo มาด้วย — เลข GRPO ต่อชิ้นที่หน้าฟอร์มแสดงอยู่ในตารางนั้นแล้ว
            with: { grpoLines: { with: { grpo: true }, orderBy: (line, { asc }) => [asc(line.grpoId)] } },
          },
        },
      },
    },
  });
  if (!request) throw new NotFoundError(`Asset request ${id}`);
  return request;
}

// list แบบเบา (ไม่พ่วง relations) — โครงเดียวกับ findPage ของ purchase-order.service.ts
// ประกอบ where เฉพาะเงื่อนไขที่ "มีค่า": isNull(deletedAt) เป็นฐาน + status/createBy ถ้าส่งมา
export async function listMyDrafts({ page, limit, status, createBy }: ListQuery) {
  const conditions = [isNull(assetRequest.deletedAt)];
  if (status) conditions.push(eq(assetRequest.status, status));
  if (createBy) conditions.push(eq(assetRequest.createdBy, createBy));
  const where = and(...conditions);

  // ยิงคู่ขนานเพราะสอง query ไม่พึ่งกัน — ประหยัดเวลาเท่า query ที่ช้ากว่า
  const [rows, totalResult] = await Promise.all([
    db.query.assetRequest.findMany({
      where,
      orderBy: desc(assetRequest.updatedAt),
      limit,
      offset: (page - 1) * limit,
    }),
    db.select({ value: count() }).from(assetRequest).where(where),
  ]);

  return paginate(rows, totalResult[0].value, page, limit);
}

// [การตัดสินใจชั่วคราวที่ต้องจดให้ตัวเอง — เรื่อง createBy]
// ตอนนี้รับ createBy จาก body เพราะยังไม่มีระบบ login
// TODO(auth): เมื่อมี JWT ต้อง "ห้าม" รับ identity จาก body เด็ดขาด — อ่านจาก token เท่านั้น
// หลักคิด: ทุกอย่างที่ client ส่งมาคือสิ่งที่ปลอมได้ — ตัวตนต้องมาจากสิ่งที่ server ตรวจสอบเอง
// (ตอนนั้นค่อยตัด createBy ออกจาก createDraftBody แล้ว signature ของ function นี้ไม่ต้องเปลี่ยน)
