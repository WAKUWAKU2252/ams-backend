import {
  pgTable,
  serial,
  bigint,
  varchar,
  date,
  foreignKey,
  index,
  uuid,
  integer,
  numeric,
  customType,
  pgEnum,
  boolean,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// column เป็น `timestamp without time zone` — pg คืน wall-clock string ('YYYY-MM-DD HH:mm:ss.ffffff')
// ถือ wall-clock เป็น UTC แล้ว format เป็น ISO-Z (ตัดเป็น ms) ให้ตรงกับที่ TypeORM เคยส่ง
// ไม่ใช้ mode:'date' เพราะ node-postgres จะตีความเป็น local time ทำให้เวลาเลื่อนตาม timezone เครื่อง
const isoTimestamp = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'timestamp';
  },
  fromDriver(value) {
    return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
  },
});
// ต้อง export — drizzle-kit อ่านเฉพาะ export ตอน push ไม่งั้นไม่สร้าง CREATE TYPE ให้
// ชนิดของเอกสาร (คนละแกนกับ "เอกสารนี้เป็นของใคร" ซึ่งฝั่งเจ้าของถือ FK เอง)
export const enumDocType = pgEnum('doc_type', ['INVOICE', 'ASSET_IMG']);


// ── Tables ตรงกับ ams_db จริง (introspect ผ่าน drizzle-kit pull) ──

// ตาราง bookkeeping เก่าของ TypeORM — เก็บไว้ใน schema เพื่อกัน drizzle-kit generate สั่ง DROP
// ไม่ได้ใช้ใน runtime (Drizzle ใช้ตาราง __drizzle_migrations ของตัวเอง)
export const migrations = pgTable('migrations', {
  id: serial().primaryKey().notNull(),
  timestamp: bigint({ mode: 'number' }).notNull(),
  name: varchar().notNull(),
});

export const purchaseOrder = pgTable('purchase_order', {
  poNumber: varchar({ length: 50 }).primaryKey().notNull(),
  vendorName: varchar({ length: 100 }),
  poDate: date(),
  status: varchar({ length: 20 }).default('PENDING').notNull(),
  createdAt: isoTimestamp().default(sql`now()`).notNull(),
  updatedAt: isoTimestamp().default(sql`now()`).notNull(),
});

export const purchaseOrderItem = pgTable(
  'purchase_order_item',
  {
    id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
    poLine: integer().notNull(),
    itemDescription: varchar().notNull(),
    quantity: integer().notNull(),
    // mode: 'number' — pg คืน numeric เป็น string ถ้าไม่กำหนด; frontend ต้องใช้เป็นตัวเลข
    unitPrice: numeric({ mode: 'number' }).notNull(),
    poNumber: varchar({ length: 50 }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.poNumber],
      foreignColumns: [purchaseOrder.poNumber],
      name: 'fk_purchase_order_item_po_number',
    }).onDelete('cascade'),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ต้องมีเพื่อ join items ของ PO และ cascade delete
    index('idx_purchase_order_item_po_number').on(table.poNumber),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// attachment — ตาราง "ไฟล์" ล้วน ไม่รู้จักใครทั้งนั้น ฝั่งเจ้าของเป็นคนถือ FK ชี้เข้ามา
// (grpo.invoiceId / asset.imageId) — เดิมเป็น polymorphic (entityType + entityId)
// ซึ่ง pg บังคับ integrity ให้ไม่ได้เลย: ใส่ entityId ที่ไม่มีจริงก็ insert ผ่าน
//
// ทำไมไม่แยกเป็นตาราง invoice / asset_image: metadata เหมือนกันทุกคอลัมน์ แยกแล้ว
// logic upload / soft delete / cleanup / ย้ายไป NAS ต้องทำซ้ำสองชุด และเอกสารชนิดที่ 3
// (Movement) จะตามมาอีก — ใช้ docType แยกชนิดพอ ส่วนความปลอดภัยได้จาก composite FK ข้างล่าง
// ═══════════════════════════════════════════════════════════════════════════
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
    createdAt: isoTimestamp()
      .default(sql`now()`)
      .notNull(),
    deletedAt: isoTimestamp(),
  },
  (table) => [
    // ปลายทางของ composite FK ฝั่ง grpo/asset — บังคับให้ asset.imageId ชี้ได้เฉพาะแถว
    // ASSET_IMG และ grpo.invoiceId ชี้ได้เฉพาะ INVOICE (แนบผิดชนิด = insert ไม่ผ่านตั้งแต่ DB)
    // ต้องเป็น unique() ไม่ใช่ uniqueIndex(): drizzle-kit introspect unique index ที่ขึ้นต้น
    // ด้วย primary key ไม่ติด แล้วจะสั่งสร้างซ้ำทุกครั้งที่ push จน push พังถาวร
    unique('uq_attachment_id_doc_type').on(table.id, table.docType),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// grpo — หนึ่งแถว = การตรวจรับของหนึ่งรอบ (หนึ่งใบ GRPO ใน SAP)
// เดิม grpoNo/grpoDate ถูกเขียนซ้ำทุกแถวใน grpo_line (8 แถวต่อใบ) จึงบังคับ unique
// ไม่ได้เลย และไม่มี "ตัวตนของ GRPO หนึ่งใบ" ให้ invoice ผูก — ตารางนี้แก้ทั้งสองเรื่อง
// ═══════════════════════════════════════════════════════════════════════════
export const grpo = pgTable(
  'grpo',
  {
    id: serial().primaryKey().notNull(),
    grpoNo: varchar({ length: 50 }).notNull(),
    grpoDate: date().notNull(),

    // invoice ของรอบนี้ — ตั้งใจ "ไม่" unique: vendor ส่งของหลายรอบแล้วออกใบเรียกเก็บ
    // รวมใบเดียวได้ หลาย grpo จึงชี้ attachment แถวเดียวกันได้ (ไฟล์บน disk มีใบเดียว)
    invoiceId: uuid(),
    // คู่กับ invoiceId ในการทำ composite FK — ค่าคงที่ ไม่ได้ให้ใครเขียน
    invoiceDocType: enumDocType().generatedAlwaysAs(sql`'INVOICE'::doc_type`),
  },
  (table) => [
    foreignKey({
      columns: [table.invoiceId, table.invoiceDocType],
      foreignColumns: [attachment.id, attachment.docType],
      name: 'fk_grpo_invoice',
    }),
    // เลข GRPO จาก SAP ห้ามซ้ำทั้งระบบ — บังคับได้เพราะขึ้นมาอยู่ระดับ header แล้ว
    uniqueIndex('uq_grpo_no').on(table.grpoNo),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอบ "invoice ใบนี้ครอบ GRPO ไหนบ้าง"
    index('idx_grpo_invoice_id').on(table.invoiceId),
  ],
);

// grpo_line — รอบนี้รับ PO line ไหน จำนวนเท่าไร (ระดับ "รอบ × po line" ไม่ใช่ระดับชิ้น)
// ความเป็นชิ้นเกิดที่ asset เท่านั้น — ตอนตรวจรับยังไม่มีใครรู้ว่าชิ้นไหนเป็นชิ้นไหน
export const grpoLine = pgTable(
  'grpo_line',
  {
    id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
    grpoId: integer().notNull(),
    poItemId: uuid().notNull(),
    // จำนวนที่ "รับจริง" ในรอบนี้ — คนละตัวกับ purchase_order_item.quantity (จำนวนสั่ง)
    // ของมาไม่ครบ/ทยอยมา สองค่านี้จะต่างกันเสมอ และค่านี้คือเพดานจำนวน asset
    // ที่ลงทะเบียนจากรอบนี้ได้ (ไม่มีค่านี้ = validate จำนวนไม่ได้เลย)
    receivedQty: integer().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.grpoId],
      foreignColumns: [grpo.id],
      name: 'fk_grpo_line_grpo',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.poItemId],
      foreignColumns: [purchaseOrderItem.id],
      name: 'fk_grpo_line_po_item',
    }).onDelete('cascade'),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ต้องมีเพื่อ join และ cascade delete
    index('idx_grpo_line_grpo_id').on(table.grpoId),
    index('idx_grpo_line_po_item_id').on(table.poItemId),
    // รอบเดียวกันรับ line เดิมซ้ำสองแถวไม่ได้ — ถ้ารับเพิ่มต้องเป็น GRPO รอบใหม่
    uniqueIndex('uq_grpo_line').on(table.grpoId, table.poItemId),
  ],
);

// ── Relations — key ต้องเป็น items / grpoLines ให้ตรงกับ response shape เดิม ──

export const purchaseOrderRelations = relations(purchaseOrder, ({ many }) => ({
  items: many(purchaseOrderItem),
  assetRequests: many(assetRequest),
}));

export const purchaseOrderItemRelations = relations(purchaseOrderItem, ({ one, many }) => ({
  purchaseOrder: one(purchaseOrder, {
    fields: [purchaseOrderItem.poNumber],
    references: [purchaseOrder.poNumber],
  }),
  grpoLines: many(grpoLine),
}));

export const grpoLineRelations = relations(grpoLine, ({ one, many }) => ({
  grpo: one(grpo, {
    fields: [grpoLine.grpoId],
    references: [grpo.id],
  }),
  poItem: one(purchaseOrderItem, {
    fields: [grpoLine.poItemId],
    references: [purchaseOrderItem.id],
  }),
  assets: many(asset),
}));

export const grpoRelations = relations(grpo, ({ one, many }) => ({
  lines: many(grpoLine),
  invoice: one(attachment, {
    fields: [grpo.invoiceId],
    references: [attachment.id],
  }),
}));


export const enumRequestStatus = pgEnum('request_status',
    ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'REGISTERED', 'CANCELLED'])

export const assetRequest = pgTable(
  'asset_request',
  {
    id: serial().primaryKey().notNull(),

    // สายรกของคำขอ (design A): draft 1 ใบครอบ PO ทั้งใบ — ราย line/รายชิ้นอยู่ที่ asset.grpo_line_id
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
    // ใครมาเจอ draft ค้างก็รับใบเดิมไปทำต่อ) — เช็คใน service กันเคสปกติ
    // index ตัวนี้กันเคสเบียด (สอง request พร้อมกัน) ที่การเช็คก่อน insert มองไม่เห็น
    uniqueIndex('uq_asset_request_draft')
      .on(table.poNumber)
      .where(sql`${table.status} = 'DRAFT' AND ${table.deletedAt} IS NULL`),
  ],
);

// ── Relations ของ asset_request — ประกาศสองฝั่งให้ query ได้ทั้งขึ้นและลง ──

export const assetRequestRelations = relations(assetRequest, ({ one, many }) => ({
  purchaseOrder: one(purchaseOrder, {
    fields: [assetRequest.poNumber],
    references: [purchaseOrder.poNumber],
  }),
  assets: many(asset),
}));

// ═══════════════════════════════════════════════════════════════════════════
// Master data — ตรงกับ Masterdata.xlsx sheet Category / Uom / Department /
// Asset location / Asset sub location / Employee
//
// กติกาที่ใช้ร่วมกันทุกตารางในกลุ่มนี้:
//   - ชื่อที่ผู้ใช้เห็นต้อง UNIQUE — ถ้าซ้ำได้ dropdown จะมีตัวเลือกหน้าตาเหมือนกันเป๊ะ
//     ผู้ใช้เลือกคนละ id แล้วรายงานแยกกลุ่มเพี้ยนถาวรโดยไม่มีใครรู้
//   - isActive แทนการลบ — แถวที่ถูก asset อ้างถึงแล้วลบจริงไม่ได้ (FK กันอยู่)
//     ต้องปิดใช้เพื่อไม่ให้โผล่ใน dropdown ใหม่ แต่ของเก่ายังชี้ได้อยู่
//   - createdAt/updatedAt ครบทุกตาราง — ข้อมูลอ้างอิงเปลี่ยนแล้วต้องสาวกลับได้ว่า
//     เปลี่ยนเมื่อไหร่ (วัตถุประสงค์ข้อ 4 ของโปรเจกต์: รองรับการตรวจสอบภายใน)
// ═══════════════════════════════════════════════════════════════════════════

export const category = pgTable(
  'category',
  {
    id: serial().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [unique('uq_category_name').on(table.name)],
);

export const uom = pgTable(
  'uom',
  {
    id: serial().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [unique('uq_uom_name').on(table.name)],
);

export const department = pgTable(
  'department',
  {
    id: serial().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    shortName: varchar({ length: 20 }),
    // ศูนย์ต้นทุนซ้ำ = ค่าใช้จ่ายไปผูกผิดแผนก แก้ย้อนหลังยากเพราะงบถูกปิดงวดไปแล้ว
    costCenter: varchar({ length: 100 }),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [unique('uq_department_cost_center').on(table.costCenter)],
);

export const assetLocation = pgTable('asset_location', {
  id: serial().primaryKey().notNull(),
  name: varchar({ length: 100 }).notNull(),
  // ว่างได้ — ตอนเปิดสถานที่ใหม่ยังไม่มีรูปผัง ไม่ควรบล็อกการสร้างข้อมูล
  mapUrl: varchar({ length: 500 }),
  isActive: boolean().default(true).notNull(),
  createdAt: isoTimestamp().default(sql`now()`).notNull(),
  updatedAt: isoTimestamp().default(sql`now()`).notNull(),
});

export const assetSubLocation = pgTable(
  'asset_sub_location',
  {
    id: serial().primaryKey().notNull(),
    locationId: integer().notNull(),
    // text ไม่ใช่ number: มีชั้นที่ไม่ใช่ตัวเลข เช่น B1, M
    floor: varchar({ length: 100 }),
    room: varchar({ length: 100 }),
    remark: varchar({ length: 255 }),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [assetLocation.id],
      name: 'fk_asset_sub_location_location',
    }),
    index('idx_asset_sub_location_location_id').on(table.locationId),
    // กันสร้างจุดเดิมซ้ำ (อาคารเดียวกัน ชั้น 2 ห้อง 201 ถูกเพิ่มสองครั้ง) ซึ่งจะทำให้
    // asset สองชิ้นอยู่ห้องเดียวกันจริงแต่ชี้คนละ id — รายงานตามสถานที่จะแตกเป็นสองก้อน
    unique('uq_asset_sub_location').on(table.locationId, table.floor, table.room),
  ],
);

export const employee = pgTable(
  'employee',
  {
    // ไม่ใช่ serial — เป็นรหัสพนักงานที่รับมาจากระบบ HR ต้องใส่ค่าเองตอน insert
    id: integer().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    email: varchar({ length: 100 }).notNull(),
    departmentId: integer().notNull(),
    // ลาออกแล้วปิดใช้ ไม่ลบ — asset ที่เคยอยู่ในความรับผิดชอบต้องยังสาวกลับได้ว่าเป็นของใคร
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.departmentId],
      foreignColumns: [department.id],
      name: 'fk_employee_department',
    }),
    index('idx_employee_department_id').on(table.departmentId),
    unique('uq_employee_email').on(table.email),
  ],
);

export const departmentRelations = relations(department, ({ many }) => ({
  employees: many(employee),
}));

export const employeeRelations = relations(employee, ({ one }) => ({
  department: one(department, {
    fields: [employee.departmentId],
    references: [department.id],
  }),
}));

export const assetLocationRelations = relations(assetLocation, ({ many }) => ({
  subLocations: many(assetSubLocation),
}));

export const assetSubLocationRelations = relations(assetSubLocation, ({ one }) => ({
  location: one(assetLocation, {
    fields: [assetSubLocation.locationId],
    references: [assetLocation.id],
  }),
}));

// ═══════════════════════════════════════════════════════════════════════════
// ตาราง asset — ตรงกับ Masterdata.xlsx sheet "Asset"
// แถว asset เกิดตั้งแต่กด "ลงทะเบียน" ในคำขอ (lifecycle=DRAFT) — ระบบอื่น
// (Dashboard/Audit/Report) ต้อง query เฉพาะ lifecycle='REGISTERED' เสมอ
//
// FK ไป master data ผูกครบแล้ว (category / uom / asset_location / asset_sub_location /
// employee) — ไม่ cascade ทุกตัว: master ถูกลบไม่ได้ถ้ายังมี asset ชี้อยู่ ต้องปิด isActive แทน
//
// createdBy/updatedBy/deletedBy: Masterdata = INTEGER FK->User แต่ใช้ varchar ชั่วคราว
// ให้สอดคล้องกับ asset_request (ยังไม่มี auth) — TODO(auth): เปลี่ยนเป็น FK -> users
// ═══════════════════════════════════════════════════════════════════════════

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
    // ชิ้นนี้มาจากรอบรับของ (GRPO) ไหน — grpo_line มีทั้ง grpoNo และ poItemId ในตัว
    // จึงไต่กลับหา PO line ได้ (asset -> grpo_line.poItemId) โดยไม่ต้องเก็บ poItemId ซ้ำ
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
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอน join/นับ asset ของคำขอ และของรอบรับของ
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

export const assetRelations = relations(asset, ({ one }) => ({
  request: one(assetRequest, {
    fields: [asset.requestId],
    references: [assetRequest.id],
  }),
  grpoLine: one(grpoLine, {
    fields: [asset.grpoLineId],
    references: [grpoLine.id],
  }),
  image: one(attachment, {
    fields: [asset.imageId],
    references: [attachment.id],
  }),
  category: one(category, {
    fields: [asset.categoryId],
    references: [category.id],
  }),
  uom: one(uom, {
    fields: [asset.uomId],
    references: [uom.id],
  }),
  location: one(assetLocation, {
    fields: [asset.locationId],
    references: [assetLocation.id],
  }),
  subLocation: one(assetSubLocation, {
    fields: [asset.subLocationId],
    references: [assetSubLocation.id],
  }),
  employee: one(employee, {
    fields: [asset.employeeId],
    references: [employee.id],
  }),
}));



// ═══════════════════════════════════════════════════════════════════════════
// STEP (asset-request): ตาราง asset_request — เขียนต่อท้ายไฟล์นี้
// วิธีคิด: db/schema.ts คือความจริงหนึ่งเดียวของโครงสร้างข้อมูล — ทุก module มา
// ประกาศตารางที่นี่ ไม่ประกาศในโฟลเดอร์ตัวเอง (แก้ที่เดียว เห็นภาพรวมที่เดียว)
//
// 1) enum สถานะ — ประกาศก่อนตาราง (ต้อง export ไม่งั้น drizzle-kit ไม่สร้าง CREATE TYPE)
//    export const enumRequestStatus = pgEnum('request_status',
//      ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'REGISTERED', 'CANCELLED'])
//    ข้อคิด: สถานะพวกนี้ "เกิดจากการตัดสินใจของมนุษย์" (กดส่ง/กดอนุมัติ) — derive ไม่ได้
//    จึงต้อง store / ต่างจากสถานะของ PO line ที่เป็นเลขคณิต (สั่ง−รับ−ลงแล้ว) ซึ่งห้าม store
//    และใช้ enum ไม่ใช่ varchar เพื่อให้ DB ปฏิเสธค่ามั่วตั้งแต่ INSERT
//
// 2) ตาราง assetRequest — คอลัมน์ตาม Masterdata.xlsx sheet "Asset request":
//    id           serial PK — เลขเทคนิครันอัตโนมัติ (กระโดดได้ ไม่ใช่เลขเอกสารโชว์ผู้ใช้)
//    poNumber     varchar(50) .notNull() + foreignKey -> purchaseOrder.poNumber
//                 ★ สายรกของคำขอ (design A): draft 1 ใบครอบ PO "ทั้งใบ" — line/qty ไม่เก็บซ้ำ
//                 รายละเอียดราย line/รายชิ้นอยู่ที่ asset.grpo_line_id (ไต่กลับหา line ได้เสมอ)
//    status       enumRequestStatus .default('DRAFT').notNull()
//    submittedAt / approvedBy / approvedAt / rejectReason / completeDate — nullable ทั้งแผง
//                 ★ หลักคิดของ draft: DRAFT = "ยังไม่เสร็จ" DB จึงต้องหลวม (ยอม NULL)
//                 แล้วความเข้มทั้งหมดไปอยู่ที่ด่าน submit ใน service — เข้มผิดชั้น ระบบใช้ไม่ได้
//    createBy     varchar ไปก่อน (ยังไม่มีระบบ user) — TODO(auth): เปลี่ยนเป็น FK -> users
//    createdAt / updatedAt   isoTimestamp .default(sql`now()`).notNull()
//                 updatedAt มีหน้าที่พิเศษ: ตัวตัดสิน "draft ร้าง" ของ cleanup job อนาคต
//    deletedAt / deletedBy   soft delete ตามกติกาโปรเจกต์ (ห้ามลบจริง)
//
// 3) index — 2 ตัว 2 เหตุผลต่างกัน:
//    index('idx_asset_request_po_number').on(poNumber)
//      ← FK ต้องมี index เสมอ (pg ไม่สร้างให้เอง — บทเรียนเดียวกับ grpo_line)
//    uniqueIndex('uq_asset_request_draft').on(poNumber)
//      .where(sql`status = 'DRAFT' AND deleted_at IS NULL`)
//      ★ กติกาธุรกิจ: PO หนึ่งใบมี draft ค้างได้ใบเดียวทั้งระบบ (ไม่แยกตามคน)
//      ★ วิธีคิดสำคัญที่สุดของ module นี้: service จะเช็ค "มี draft ค้างไหม" ก่อน insert
//      ก็จริง แต่สอง request ที่เบียดมาพร้อมกัน (ดับเบิลคลิก) จะผ่านการเช็คทั้งคู่
//      เพราะต่างคนต่างยังไม่เห็นของอีกฝ่าย — partial unique index คือกรรมการชั้นสุดท้าย
//      ที่การเบียดผ่านไม่ได้ (เช็คใน code กันเคสปกติ / index กันเคสเบียด — ต้องมีทั้งคู่)
//
// 4) relations — ประกาศสองฝั่งให้ query ได้ทั้งขึ้นและลง:
//    assetRequestRelations: purchaseOrder = one(purchaseOrder, { fields: [poNumber], references })
//    และเพิ่มใน purchaseOrderRelations เดิม: assetRequests: many(assetRequest)
//
// 5) เสร็จแล้วรัน bun run db:push (workflow push — diff เข้า DB ตรง ไม่มีไฟล์ migration)
//    แล้วเปิด pgAdmin เช็คว่า ตาราง + enum + partial index เกิดครบจริง
// ═══════════════════════════════════════════════════════════════════════════
