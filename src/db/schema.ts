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
export const enumEntity = pgEnum("entity_kind",["INVOICE","ASSET_IMG"])


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

export const grpoLine = pgTable(
  'grpo_line',
  {
    id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
    grpoNo: varchar({ length: 50 }).notNull(),
    grpoDate: date().notNull(),
    poItemId: uuid().notNull(),
    receivedQty: integer().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.poItemId],
      foreignColumns: [purchaseOrderItem.id],
      name: 'fk_grpo_line_po_item',
    }).onDelete('cascade'),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ต้องมีเพื่อ join grpoLines ของ item และ cascade delete
    index('idx_grpo_line_po_item_id').on(table.poItemId),
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

export const grpoLineRelations = relations(grpoLine, ({ one }) => ({
  poItem: one(purchaseOrderItem, {
    fields: [grpoLine.poItemId],
    references: [purchaseOrderItem.id],
  }),
}));

export const attachment = pgTable(
  "attachment",
  {
    id: uuid()
      .default(sql`uuid_generate_v4()`)
      .primaryKey()
      .notNull(),
    entityKind: enumEntity().notNull(),
    entityType: varchar({ length: 50 }).notNull(),
    entityId: uuid(),
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
    // query หลักคือ "ไฟล์ของ record นี้มีอะไรบ้าง" — ไม่มี index = seq scan ทุกครั้ง
    index('idx_attachment_entity').on(table.entityType, table.entityId),
  ],
);


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

export const assetRequestRelations = relations(assetRequest, ({ one }) => ({
  purchaseOrder: one(purchaseOrder, {
    fields: [assetRequest.poNumber],
    references: [purchaseOrder.poNumber],
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
