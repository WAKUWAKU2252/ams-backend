// ═══════════════════════════════════════════════════════════════════════════
// asset — ตรงกับ Masterdata.xlsx sheet "Asset" / หนึ่งแถว = ของหนึ่งชิ้นจริง
// แถวเกิดตั้งแต่กด "ลงทะเบียน" ในคำขอ (lifecycle=DRAFT) — ระบบอื่น
// (Dashboard/Audit/Report) ต้อง query เฉพาะ lifecycle='REGISTERED' เสมอ
//
// FK ไป master ไม่ cascade ทุกตัว: master ถูกลบไม่ได้ถ้ายังมี asset ชี้อยู่ ต้องปิด isActive แทน
//
// createdBy/updatedBy/deletedBy: Masterdata = INTEGER FK->User แต่ใช้ varchar ชั่วคราว
// ให้สอดคล้องกับ asset_request (ยังไม่มี auth) — TODO(auth): เปลี่ยนเป็น FK -> users
// ═══════════════════════════════════════════════════════════════════════════
import { pgTable, pgEnum, serial, varchar, uuid, integer, foreignKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from './_shared';
import { attachment, enumDocType } from './attachment';
import { grpoLine } from './grpo';
import { assetRequest } from './asset-request';
import { category, uom, assetLocation, assetSubLocation, employee } from './master';

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

    // ชี้กลับใบคำขอที่ทำให้ชิ้นนี้เกิด
    requestId: integer().notNull(),
    // ลำดับเครื่องภายในคำขอ — คู่กับ requestId เป็นกุญแจกันแถวซ้ำ (ดู uq_asset_unit)
    unitNo: integer().notNull(),
    // ชิ้นนี้มาจากรอบรับของ (GRPO) ไหน — grpo_line ชี้ต่อไปที่ grpo และ poItem ในตัว
    // จึงไต่กลับหา PO line และเลข GRPO ได้โดยไม่ต้องเก็บซ้ำ
    grpoLineId: uuid().notNull(),

    // เลขทะเบียนจริงจาก SAP — NULL ระหว่าง DRAFT (SAP ออกเลขหลังอนุมัติ)
    // service บังคับต้องมีค่าเมื่อ lifecycle='REGISTERED'; UNIQUE ของ pg ยอมหลาย NULL
    assetNumber: varchar({ length: 100 }),
    description: varchar({ length: 100 }),
    serialNumber: varchar({ length: 100 }),

    categoryId: integer().notNull(),
    assetClass: varchar({ length: 50 }),
    qrCode: varchar({ length: 255 }),

    // วงจรชีวิตเอกสาร (คนละแกนกับ status) — DRAFT->REGISTERED เดินทางเดียว ไม่ย้อนกลับ
    lifecycle: enumAssetLifecycle().default('DRAFT').notNull(),
    // สภาพการใช้งานจริง — มีความหมายเมื่อ REGISTERED แล้ว (ระหว่าง DRAFT ตั้ง Active รอไว้)
    status: enumAssetStatus().default('Active'),

    uomId: integer().notNull(),
    // ว่างได้: ของที่รับเข้าคลังแล้วยังไม่จ่ายให้ใครถือ ยังไม่มีผู้รับผิดชอบ
    employeeId: integer(),
    locationId: integer().notNull(),
    // ว่างได้: บางที่ระบุแค่อาคาร ไม่ได้ลงลึกถึงชั้น/ห้อง
    subLocationId: integer(),

    warrantyStartDate: isoTimestamp(),
    warrantyEndDate: isoTimestamp(),

    // รูปของชิ้นนี้ — คอลัมน์เดียว = 1 ชิ้นไม่เกิน 1 รูป, unique (ดูข้างล่าง) = ห้ามสองชิ้น
    // ใช้ไฟล์เดียวกัน เพราะรูปมีไว้ยืนยันตัวตน/สภาพ "รายชิ้น" ให้ Audit ใช้เทียบตอนสแกน QR
    // ถ้าใช้รูปร่วมกันได้ รูปจะพิสูจน์อะไรไม่ได้เลย — NULL ระหว่าง DRAFT (pg ยอมหลาย NULL)
    imageId: uuid(),
    // คู่กับ imageId ในการทำ composite FK — ค่าคงที่ ไม่ได้ให้ใครเขียน
    imageDocType: enumDocType().generatedAlwaysAs(sql`'ASSET_IMG'::doc_type`),

    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    createdBy: varchar({ length: 100 }).notNull(), // temp varchar — TODO(auth) FK -> users
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedBy: varchar({ length: 100 }).notNull(), // temp varchar — TODO(auth) FK -> users

    deletedAt: isoTimestamp(),
    deletedBy: varchar({ length: 100 }), // temp varchar — TODO(auth) FK -> users
  },
  (table) => [
    // ไม่ cascade: asset เป็นข้อมูลธุรกิจ (soft delete) — ห้ามหายเงียบตามคำขอ/รอบรับของที่ถูกลบ
    foreignKey({
      columns: [table.requestId],
      foreignColumns: [assetRequest.id],
      name: 'fk_asset_request',
    }),
    foreignKey({
      columns: [table.grpoLineId],
      foreignColumns: [grpoLine.id],
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
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอนกรองตามหมวด/สถานที่/ผู้ถือครองใน Dashboard
    index('idx_asset_category_id').on(table.categoryId),
    index('idx_asset_location_id').on(table.locationId),
    index('idx_asset_employee_id').on(table.employeeId),
    // ใช้ตอน join/นับ asset ของคำขอ และของรอบรับของ
    index('idx_asset_request_id').on(table.requestId),
    index('idx_asset_grpo_line_id').on(table.grpoLineId),
    // กันดับเบิลคลิกแล้วได้แถวซ้ำ: 1 คำขอมี unit_no ซ้ำไม่ได้ (นับเฉพาะที่ยังไม่ถูกลบ)
    uniqueIndex('uq_asset_unit').on(table.requestId, table.unitNo).where(sql`${table.deletedAt} IS NULL`),
    // เลข SAP ต้องไม่ซ้ำ — pg ยอมหลาย NULL อยู่แล้ว (ช่วง DRAFT ยังไม่มีเลข)
    uniqueIndex('uq_asset_number').on(table.assetNumber),
    // 1 ไฟล์รูป = 1 ชิ้น ห้ามใช้ร่วม — เปลี่ยนรูปต้องอัปไฟล์ใหม่แล้วสลับ imageId
    // (ห้ามเขียนทับไฟล์เดิมบน disk: browser cache ค้าง + ทำลายหลักฐานรูปตอนรับของ)
    uniqueIndex('uq_asset_image').on(table.imageId),
  ],
);
