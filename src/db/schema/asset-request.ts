// ใบคำขอลงทะเบียน — draft 1 ใบครอบ PO ทั้งใบ (design A)
// ราย line/รายชิ้นอยู่ที่ asset.grpoLineId ไม่เก็บซ้ำที่นี่
//
// หลักคิดของ draft: DRAFT = "ยังไม่เสร็จ" DB จึงต้องหลวม (ยอม NULL เกือบทั้งแผง)
// แล้วความเข้มทั้งหมดไปอยู่ที่ด่าน submit ใน service — เข้มผิดชั้น ระบบใช้ไม่ได้
import { pgTable, pgEnum, serial, varchar, integer, foreignKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from './_shared';
import { purchaseOrder } from './purchase';
import { user } from './user';

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
    // FK -> user.id: manager ที่กด approve/reject (audit) — เดิม varchar, ย้ายเป็น FK
    approvedBy: integer(),
    approvedAt: isoTimestamp(),
    rejectedBy: integer(),
    rejectedAt: isoTimestamp(),
    rejectReason: varchar({ length: 500 }),
    completeDate: isoTimestamp(),

    // FK -> user.id: ใครเปิดใบนี้คนแรก (audit) — อ่านจาก token เท่านั้น ห้ามรับจาก body
    createdBy: integer().notNull(),

    // FK -> user.id: manager ที่คำขอนี้ถูก route ไปหา (snapshot ตอน submit) = หัวหน้าแผนกของผู้เปิด PO
    // ไว้ audit/escalation และให้ callback ตอนกดอนุมัติเทียบว่าคนกดตรงกับผู้ที่ตั้งใจส่งไปหา; nullable ตอน DRAFT
    assignedManagerId: integer(),

    // lock กันแก้พร้อมกันย้ายไป in-memory (presence registry) แล้ว — ไม่เก็บที่ DB อีก
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    // ตัวตัดสิน "draft ร้าง" ของ cleanup job อนาคต + optimistic check กัน lost update ตอน save
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),

    deletedAt: isoTimestamp(),
    // FK -> user.id เหมือน approvedBy/rejectedBy/createdBy — เดิมเป็น varchar อยู่คอลัมน์เดียวในตาราง
    deletedBy: integer(),
  },
  (table) => [
    // ไม่ cascade: ใบคำขอเป็นข้อมูลธุรกิจ (soft delete) — ห้ามหายเงียบตาม PO ที่ถูกลบ
    foreignKey({
      columns: [table.poNumber],
      foreignColumns: [purchaseOrder.poNumber],
      name: 'fk_asset_request_po_number',
    }),
    // ลบ user ที่ยังมี draft ค้างอยู่ไม่ได้ (ไม่ cascade — ใบคำขอเป็นข้อมูลธุรกิจ soft delete)
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_created_by',
    }),
    foreignKey({
      columns: [table.approvedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_approved_by',
    }),
    foreignKey({
      columns: [table.rejectedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_rejected_by',
    }),
    foreignKey({
      columns: [table.deletedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_deleted_by',
    }),
    foreignKey({
      columns: [table.assignedManagerId],
      foreignColumns: [user.id],
      name: 'fk_asset_request_assigned_manager',
    }),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอน join/เช็ค draft ของ PO
    index('idx_asset_request_po_number').on(table.poNumber),
    index('idx_asset_request_assigned_manager_id').on(table.assignedManagerId),
    index('idx_asset_request_created_by').on(table.createdBy),
    index('idx_asset_request_approved_by').on(table.approvedBy),
    index('idx_asset_request_rejected_by').on(table.rejectedBy),
    index('idx_asset_request_deleted_by').on(table.deletedBy),
    // กรรมการกันใบซ้ำ: PO หนึ่งใบมี "คำขอที่ยัง active" ได้ใบเดียวทั้งระบบ
    // active = ทุกสถานะยกเว้น terminal (REGISTERED/CANCELLED) — กันเปิดใบใหม่ทับใบที่ยังวิ่งอยู่
    // (เดิมครอบแค่ DRAFT ทำให้ reject แล้วเปิดใหม่ได้ซ้ำ — review #1) service reuse ใบเดิมให้
    uniqueIndex('uq_asset_request_active')
      .on(table.poNumber)
      .where(sql`${table.status} NOT IN ('REGISTERED', 'CANCELLED') AND ${table.deletedAt} IS NULL`),
  ],
);
