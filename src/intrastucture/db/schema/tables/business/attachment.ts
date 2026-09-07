// ═══════════════════════════════════════════════════════════════════════════
// attachment — ตาราง "ไฟล์" ล้วน ไม่รู้จักใครทั้งนั้น ฝั่งเจ้าของเป็นคนถือ FK ชี้เข้ามา
// (grpo.invoiceId / asset.imageId) — เดิมเป็น polymorphic (entityType + entityId)
// ซึ่ง pg บังคับ integrity ให้ไม่ได้เลย: ใส่ entityId ที่ไม่มีจริงก็ insert ผ่าน
//
// ทำไมไม่แยกเป็นตาราง invoice / asset_image: metadata เหมือนกันทุกคอลัมน์ แยกแล้ว
// logic upload / soft delete / cleanup / ย้ายไป NAS ต้องทำซ้ำสองชุด และเอกสารชนิดถัดไป
// ที่จะตามมาก็ต้องทำซ้ำอีก — ใช้ docType แยกชนิดพอ ส่วนความปลอดภัยได้จาก composite FK
// ที่ฝั่ง grpo/asset ซึ่งอ้าง unique (id, docType) ข้างล่าง
// ═══════════════════════════════════════════════════════════════════════════
import { pgTable, pgEnum, uuid, varchar, integer, unique, foreignKey, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from '@intrastucture/db/schema/shared/iso-timestamp';
import { user } from '@intrastucture/db/schema/user';

// ต้อง export — drizzle-kit อ่านเฉพาะ export ตอน push ไม่งั้นไม่สร้าง CREATE TYPE ให้
// ชนิดของเอกสาร (คนละแกนกับ "เอกสารนี้เป็นของใคร" ซึ่งฝั่งเจ้าของถือ FK เอง)
export const enumDocType = pgEnum('doc_type', ['INVOICE', 'ASSET_IMG']);

export const attachment = pgTable(
  'attachment',
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    docType: enumDocType().notNull(),
    originalName: varchar({ length: 255 }).notNull(),
    storedName: varchar({ length: 100 }).notNull(),
    mimeType: varchar({ length: 100 }).notNull(),
    size: integer().notNull(),
    // ใครอัปโหลดไฟล์นี้ — NOT NULL ทุกไฟล์ต้องรู้ที่มา (Finding #5 — ขัดวัตถุประสงค์ข้อ 4 ถ้าไม่มี)
    uploadedBy: integer().notNull(),
    createdAt: isoTimestamp()
      .default(sql`now()`)
      .notNull(),
    updatedAt: isoTimestamp()
      .default(sql`now()`)
      .notNull(),
    deletedAt: isoTimestamp(),
    // ใครลบไฟล์ (soft delete) — nullable เพราะเซ็ตเฉพาะตอนถูกลบ
    deletedBy: integer(),
  },
  (table) => [
    // ปลายทางของ composite FK ฝั่ง grpo/asset — บังคับให้ asset.imageId ชี้ได้เฉพาะแถว
    // ASSET_IMG และ grpo.invoiceId ชี้ได้เฉพาะ INVOICE (แนบผิดชนิด = insert ไม่ผ่านตั้งแต่ DB)
    // ต้องเป็น unique() ไม่ใช่ uniqueIndex(): drizzle-kit introspect unique index ที่ขึ้นต้น
    // ด้วย primary key ไม่ติด แล้วจะสั่งสร้างซ้ำทุกครั้งที่ push จน push พังถาวร
    unique('uq_attachment_id_doc_type').on(table.id, table.docType),
    // ไม่ cascade: ลบ user ที่เคยอัป/ลบไฟล์ไม่ได้ ประวัติต้องอยู่ (เหมือน audit trail ของ asset)
    foreignKey({ columns: [table.uploadedBy], foreignColumns: [user.id], name: 'fk_attachment_uploaded_by' }),
    foreignKey({ columns: [table.deletedBy], foreignColumns: [user.id], name: 'fk_attachment_deleted_by' }),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง
    index('idx_attachment_uploaded_by').on(table.uploadedBy),
    index('idx_attachment_deleted_by').on(table.deletedBy),
  ],
);
