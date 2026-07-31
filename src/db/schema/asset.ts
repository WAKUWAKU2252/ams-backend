import {
  pgTable,
  pgEnum,
  serial,
  varchar,
  uuid,
  integer,
  numeric,
  boolean,
  foreignKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from './_shared';
import { attachment, enumDocType } from './attachment';
import { grpoLine } from './grpo';
import { assetRequest } from './asset-request';
import { category, uom, assetLocation, assetSubLocation, employee } from './master';
import { user } from './user';

export const enumAssetLifecycle = pgEnum('asset_lifecycle', ['DRAFT', 'REGISTERED']);

export const enumAssetStatus = pgEnum('asset_status', [
  'Active',
  'Inactive',
  'Under Maintenance',
  'Lost',
  'Disposed',
]);

export const asset = pgTable(
  'asset',
  {
    id: serial().primaryKey().notNull(),
    requestId: integer().notNull(),
    grpoLineId: uuid().notNull(),
    // copy ลงมาจาก grpo_line เพื่อให้ตั้ง unique (poItemId, unitNo) ได้ — unique ข้ามตารางทำไม่ได้
    // ไม่ใช่ copy ลอย ๆ: composite FK ข้างล่างบังคับให้ตรงกับรอบรับของจริงเสมอ
    poItemId: uuid().notNull(),
    // ชิ้นที่เท่าไรของ PO line (นับต่อเนื่องทั้งบรรทัด ข้ามรอบรับของและข้ามใบคำขอ)
    // มีไว้แทนการ "นับแล้วเทียบ" — เพดานกลายเป็นเลขที่ DB กันซ้ำให้เอง ปิด race condition
    unitNo: integer().notNull(),
    // ราคาทุนที่ "เสนอ" ตอนขอลงทะเบียน ค่าตั้งต้นจาก purchase_order_item.unitPrice
    // ตรึงไว้ ณ ตอนสร้าง — ราคาที่ลงบัญชีจริงเป็นของ SAP ซึ่งจะ sync มาทีหลังคนละคอลัมน์
    acquisitionCost: numeric({ mode: 'number' }).notNull(),
    // ชิ้นนี้เกิดจากการที่คนแจ้งจำนวนเอง ไม่ได้มาจากตัวเลข SAP ตรง ๆ
    // เป็น snapshot ณ ตอนเกิด (derive จาก asset_request_line ย้อนหลังไม่ได้ เพราะชิ้นแรก
    // ของงานเหมาก็ไม่เกิน quantity เหมือนกัน) ต้องติดตัวไปถึง Dashboard/Audit/บัญชี
    isSplitItem: boolean().default(false).notNull(),
    assetNumber: varchar({ length: 100 }),
    description: varchar({ length: 100 }),
    serialNumber: varchar({ length: 100 }),
    categoryId: integer().notNull(),
    assetClass: varchar({ length: 50 }),
    qrCode: varchar({ length: 255 }),
    lifecycle: enumAssetLifecycle().default('DRAFT').notNull(),
    status: enumAssetStatus().default('Active'),
    uomId: integer().notNull(),
    employeeId: integer(),
    locationId: integer().notNull(),
    subLocationId: integer(),
    warrantyStartDate: isoTimestamp(),
    warrantyEndDate: isoTimestamp(),
    imageId: uuid(),
    imageDocType: enumDocType().generatedAlwaysAs(sql`'ASSET_IMG'::doc_type`),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    // ทั้งสามคอลัมน์อ่านจาก token (currentUser.id) เท่านั้น ห้ามรับจาก body — เดิมเป็น varchar
    // ที่ client ส่งชื่อใครมาก็ได้ ทำให้ audit trail ของสินทรัพย์เชื่อถือไม่ได้เลย
    createdBy: integer().notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedBy: integer().notNull(),

    deletedAt: isoTimestamp(),
    deletedBy: integer(),
  },
  (table) => [
    foreignKey({
      columns: [table.requestId],
      foreignColumns: [assetRequest.id],
      name: 'fk_asset_request',
    }),
    // composite FK — ครอบ grpoLineId ไปในตัว (ไม่ต้องมี FK คอลัมน์เดียวซ้ำอีก) และบังคับว่า
    // poItemId ที่ copy ลงมาต้องเป็นของรอบรับของแถวนั้นจริง ยัดเลขมั่วเข้ามา DB ปฏิเสธเอง
    foreignKey({
      columns: [table.grpoLineId, table.poItemId],
      foreignColumns: [grpoLine.id, grpoLine.poItemId],
      name: 'fk_asset_grpo_line',
    }),
    // composite FK — imageId ชี้ไปแถว INVOICE ไม่ได้ DB ปฏิเสธเอง
    foreignKey({
      columns: [table.imageId, table.imageDocType],
      foreignColumns: [attachment.id, attachment.docType],
      name: 'fk_asset_image',
    }),
    // FK ไป master — ไม่ cascade: ลบ category ที่มี asset ใช้อยู่ไม่ได้ ต้องปิด isActive แทน
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [category.id],
      name: 'fk_asset_category',
    }),
    foreignKey({
      columns: [table.uomId],
      foreignColumns: [uom.id],
      name: 'fk_asset_uom',
    }),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [assetLocation.id],
      name: 'fk_asset_location',
    }),
    foreignKey({
      columns: [table.subLocationId],
      foreignColumns: [assetSubLocation.id],
      name: 'fk_asset_sub_location',
    }),
    foreignKey({
      columns: [table.employeeId],
      foreignColumns: [employee.id],
      name: 'fk_asset_employee',
    }),
    // ผู้ทำรายการ — ไม่ cascade: ลบ user ที่เคยลงทะเบียนสินทรัพย์ไม่ได้ ต้องปิด isActive แทน
    // (ประวัติว่าใครลงทะเบียน/แก้/ลบ ต้องอยู่ตลอดอายุสินทรัพย์ — วัตถุประสงค์ข้อ 4 ของโปรเจกต์)
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [user.id],
      name: 'fk_asset_created_by',
    }),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_updated_by',
    }),
    foreignKey({
      columns: [table.deletedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_deleted_by',
    }),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอนกรองตามหมวด/สถานที่/ผู้ถือครองใน Dashboard
    index('idx_asset_category_id').on(table.categoryId),
    index('idx_asset_location_id').on(table.locationId),
    index('idx_asset_employee_id').on(table.employeeId),
    // ใช้ตอน join/นับ asset ของคำขอ และของรอบรับของ
    index('idx_asset_request_id').on(table.requestId),
    index('idx_asset_grpo_line_id').on(table.grpoLineId),
    // ใช้ตอบ "ของที่ user คนนี้ลงทะเบียนไว้" และตอนตรวจสอบย้อนหลังว่าใครแก้/ลบ
    index('idx_asset_created_by').on(table.createdBy),
    index('idx_asset_updated_by').on(table.updatedBy),
    index('idx_asset_deleted_by').on(table.deletedBy),
    // เลข SAP ต้องไม่ซ้ำ — pg ยอมหลาย NULL อยู่แล้ว (ช่วง DRAFT ยังไม่มีเลข)
    uniqueIndex('uq_asset_number').on(table.assetNumber),
    // ใช้ตอนนับ/กรองรายชิ้นต่อ PO line โดยไม่ต้อง join grpo_line ก่อนทุกครั้ง
    index('idx_asset_po_item_id').on(table.poItemId),
    // ★ หัวใจของการคุมจำนวน: เลขชิ้นห้ามซ้ำในบรรทัดเดียวกัน
    // แทนการ "นับแล้วเทียบเพดาน" ซึ่งยิงพร้อมกันสองครั้งแล้วเกินได้ (อ่านยอดเดิมทั้งคู่)
    // partial: ชิ้นที่ถูก soft delete แล้วต้องคืนเลขให้ชิ้นใหม่ใช้ต่อได้
    uniqueIndex('uq_asset_po_item_unit_no')
      .on(table.poItemId, table.unitNo)
      .where(sql`${table.deletedAt} IS NULL`),
    // 1 ไฟล์รูป = 1 ชิ้น ห้ามใช้ร่วม — เปลี่ยนรูปต้องอัปไฟล์ใหม่แล้วสลับ imageId
    // (ห้ามเขียนทับไฟล์เดิมบน disk: browser cache ค้าง + ทำลายหลักฐานรูปตอนรับของ)
    uniqueIndex('uq_asset_image').on(table.imageId),
  ],
);
