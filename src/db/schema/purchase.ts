// ข้อมูลฝั่ง SAP ที่ AMS อ่านอย่างเดียว ไม่ได้เป็นคนสร้าง
import { pgTable, varchar, date, uuid, integer, numeric, foreignKey, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from './_shared';

// ไม่มีคอลัมน์ status โดยตั้งใจ — "รับครบหรือยัง" เป็นเลขคณิต (Σ receivedQty เทียบ quantity)
// ที่คำนวณสดได้เสมอ SAP ก็ไม่ได้ส่งค่านี้มาให้ การเก็บซ้ำจึงมีแต่ภาระต้องคอยอัปเดตทุกครั้ง
// ที่ grpo_line เปลี่ยน (เพิ่ม/แก้/ลบ/sync จาก SAP) ลืมจุดเดียวคอลัมน์ก็โกหกทันที
// โดยที่คนอ่านไม่มีทางรู้ — ดู receivedStatus ใน purchase-order.service แทน
export const purchaseOrder = pgTable('purchase_order', {
  poNumber: varchar({ length: 50 }).primaryKey().notNull(),
  vendorName: varchar({ length: 100 }),
  poDate: date(),
  requesterName: varchar({ length: 100 }),
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
    unitPrice: numeric({ mode: 'number' }).notNull(),
    poNumber: varchar({ length: 50 }).notNull(),
    // ยอดรวมจริงต่อบรรทัดจาก SAP (อาจ ≠ quantity × unitPrice เมื่อมีส่วนลด/ค่าขนส่ง) — ใช้เป็นเพดาน over-cost
    lineTotal: numeric({ mode: 'number' }).notNull(),
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
