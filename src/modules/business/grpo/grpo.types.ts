// สัญญาชนิดข้อมูลของโมดูล grpo (รอบรับของ)
import type { grpo, grpoLine, grpoInvoice } from '@intrastucture/db/schema';

export type GrpoRow = typeof grpo.$inferSelect;
export type GrpoLineRow = typeof grpoLine.$inferSelect;
export type GrpoInvoiceRow = typeof grpoInvoice.$inferSelect;

/** ผลของการแนบ/ถอด invoice — ไม่คืนตัวแถว เพราะฝั่งหน้าจอโหลดใบใหม่อยู่แล้ว */
export interface InvoiceLinkResult {
  success: true;
}
