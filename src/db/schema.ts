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
