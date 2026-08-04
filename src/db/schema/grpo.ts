// ═══════════════════════════════════════════════════════════════════════════
// grpo — หนึ่งแถว = การตรวจรับของหนึ่งรอบ (หนึ่งใบ GRPO ใน SAP)
// เดิม grpoNo/grpoDate ถูกเขียนซ้ำทุกแถวใน grpo_line (8 แถวต่อใบ) จึงบังคับ unique
// ไม่ได้เลย และไม่มี "ตัวตนของ GRPO หนึ่งใบ" ให้ invoice ผูก — ตารางนี้แก้ทั้งสองเรื่อง
// ═══════════════════════════════════════════════════════════════════════════
import { pgTable, serial, varchar, date, uuid, integer, foreignKey, index, uniqueIndex, unique, primaryKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from './_shared';
import { attachment, enumDocType } from './attachment';
import { purchaseOrderItem } from './purchase';

export const grpo = pgTable(
  'grpo',
  {
    id: serial().primaryKey().notNull(),
    grpoNo: varchar({ length: 50 }).notNull(),
    grpoDate: date().notNull(),
    // ข้อมูล SAP sync — timestamp ให้สาวได้ว่าแถวเข้า/แก้เมื่อไหร่ (Finding #11)
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
    // invoice ย้ายไปตาราง grpo_invoice แล้ว (many-to-many) — เดิม invoiceId เป็นคอลัมน์เดียว
  },
  (table) => [
    // เลข GRPO จาก SAP ห้ามซ้ำทั้งระบบ — บังคับได้เพราะขึ้นมาอยู่ระดับ header แล้ว
    uniqueIndex('uq_grpo_no').on(table.grpoNo),
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
    // ของมาไม่ครบ/ทยอยมา สองค่านี้จะต่างกันเสมอ และค่านี้คือเส้นแบ่งว่าชิ้นไหนเปิดให้กรอก
    receivedQty: integer().notNull(),
    // ข้อมูล SAP sync — timestamp ให้สาวได้ว่าแถวเข้า/แก้เมื่อไหร่ (Finding #11)
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
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
    // ไม่ได้กันอะไรเพิ่ม (id เป็น PK อยู่แล้ว) แต่เป็นปลายทางที่จำเป็นให้ asset ทำ
    // composite FK (grpoLineId, poItemId) ได้ → poItemId ที่ asset copy ลงไปจะโกหกไม่ได้
    // ต้องเป็น unique() ไม่ใช่ uniqueIndex(): drizzle-kit introspect unique index ที่ขึ้นต้น
    // ด้วย primary key ไม่ติด แล้วสั่งสร้างซ้ำทุกครั้งจน db:push พังถาวร (เคสจริง: uq_attachment_id_doc_type)
    unique('uq_grpo_line_id_po_item').on(table.id, table.poItemId),
  ],
);

// grpo_invoice — ตารางเชื่อม รอบรับของ ↔ ไฟล์ invoice (many-to-many)
// เดิม grpo.invoiceId เป็นคอลัมน์เดียว = 1 รอบได้ invoice เดียว แต่จริงรอบเดียวมีได้หลายใบ
// (เช่นใบเรียกเก็บ + ใบกำกับภาษี) และ invoice ใบเดียวยังครอบหลายรอบได้ตามเดิม
export const grpoInvoice = pgTable(
  'grpo_invoice',
  {
    grpoId: integer().notNull(),
    attachmentId: uuid().notNull(),
    // คงที่ ให้ composite FK บังคับว่าแนบได้เฉพาะไฟล์ชนิด INVOICE (แนบผิดชนิด DB ปฏิเสธเอง)
    attachmentDocType: enumDocType().generatedAlwaysAs(sql`'INVOICE'::doc_type`),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.grpoId, table.attachmentId], name: 'pk_grpo_invoice' }),
    foreignKey({
      columns: [table.grpoId],
      foreignColumns: [grpo.id],
      name: 'fk_grpo_invoice_grpo',
    }).onDelete('cascade'),
    // composite FK — แนบได้เฉพาะแถว INVOICE เท่านั้น (คู่กับ unique(id, docType) ของ attachment)
    foreignKey({
      columns: [table.attachmentId, table.attachmentDocType],
      foreignColumns: [attachment.id, attachment.docType],
      name: 'fk_grpo_invoice_attachment',
    }),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอบ "invoice ใบนี้ครอบ GRPO ไหนบ้าง" + ตอน cleanup
    index('idx_grpo_invoice_attachment_id').on(table.attachmentId),
  ],
);
