// ═══════════════════════════════════════════════════════════════════════════
// grpo — หนึ่งแถว = การตรวจรับของหนึ่งรอบ (หนึ่งใบ GRPO ใน SAP)
// เดิม grpoNo/grpoDate ถูกเขียนซ้ำทุกแถวใน grpo_line (8 แถวต่อใบ) จึงบังคับ unique
// ไม่ได้เลย และไม่มี "ตัวตนของ GRPO หนึ่งใบ" ให้ invoice ผูก — ตารางนี้แก้ทั้งสองเรื่อง
// ═══════════════════════════════════════════════════════════════════════════
import { pgTable, serial, varchar, date, uuid, integer, foreignKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { attachment, enumDocType } from './attachment';
import { purchaseOrderItem } from './purchase';

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
    // ของมาไม่ครบ/ทยอยมา สองค่านี้จะต่างกันเสมอ และค่านี้คือเส้นแบ่งว่าชิ้นไหนเปิดให้กรอก
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
