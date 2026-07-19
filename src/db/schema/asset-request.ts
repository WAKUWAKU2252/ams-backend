// ใบคำขอลงทะเบียน — draft 1 ใบครอบ PO ทั้งใบ (design A)
// ราย line/รายชิ้นอยู่ที่ asset.grpoLineId ไม่เก็บซ้ำที่นี่
//
// หลักคิดของ draft: DRAFT = "ยังไม่เสร็จ" DB จึงต้องหลวม (ยอม NULL เกือบทั้งแผง)
// แล้วความเข้มทั้งหมดไปอยู่ที่ด่าน submit ใน service — เข้มผิดชั้น ระบบใช้ไม่ได้
import { pgTable, pgEnum, serial, varchar, foreignKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from './_shared';
import { purchaseOrder } from './purchase';

// สถานะพวกนี้เกิดจากการตัดสินใจของมนุษย์ (กดส่ง/กดอนุมัติ) derive ไม่ได้จึงต้อง store
// ต่างจากสถานะของ PO line ที่เป็นเลขคณิต (สั่ง−รับ−ลงแล้ว) ซึ่งห้าม store
export const enumRequestStatus = pgEnum('request_status', [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'REGISTERED',
  'CANCELLED',
]);

export const assetRequest = pgTable(
  'asset_request',
  {
    id: serial().primaryKey().notNull(),
    poNumber: varchar({ length: 50 }).notNull(),

    // ไม่มี default+notNull = insert แล้วได้ NULL ไม่ใช่ DRAFT → กลไกกันใบซ้ำเป็นอัมพาต
    status: enumRequestStatus().default('DRAFT').notNull(),
    submittedAt: isoTimestamp(),
    approvedBy: varchar({ length: 100 }),
    approvedAt: isoTimestamp(),
    rejectReason: varchar({ length: 500 }),
    completeDate: isoTimestamp(),

    // varchar ชั่วคราวจนกว่าจะมีตาราง users — TODO(auth): เปลี่ยนเป็น FK และอ่านจาก token เท่านั้น
    createdBy: varchar({ length: 100 }).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    // ตัวตัดสิน "draft ร้าง" ของ cleanup job อนาคต
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),

    deletedAt: isoTimestamp(),
    deletedBy: varchar({ length: 100 }),
  },
  (table) => [
    // ไม่ cascade: ใบคำขอเป็นข้อมูลธุรกิจ (soft delete) — ห้ามหายเงียบตาม PO ที่ถูกลบ
    foreignKey({
      columns: [table.poNumber],
      foreignColumns: [purchaseOrder.poNumber],
      name: 'fk_asset_request_po_number',
    }),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอน join/เช็ค draft ของ PO
    index('idx_asset_request_po_number').on(table.poNumber),
    // กรรมการกันใบซ้ำ: PO หนึ่งใบมี draft ค้างได้ "ใบเดียวทั้งระบบ" (ไม่แยกตามคน —
    // ใครมาเจอ draft ค้างก็รับใบเดิมไปทำต่อ) — service เช็คกันเคสปกติ
    // index ตัวนี้กันเคสเบียด (สอง request พร้อมกัน) ที่การเช็คก่อน insert มองไม่เห็น
    uniqueIndex('uq_asset_request_draft')
      .on(table.poNumber)
      .where(sql`${table.status} = 'DRAFT' AND ${table.deletedAt} IS NULL`),
  ],
);
