// สัญญาชนิดข้อมูลของโมดูล purchase-order
import type { purchaseOrder, purchaseOrderItem } from '@intrastucture/db/schema';

export type PurchaseOrderRow = typeof purchaseOrder.$inferSelect;
export type PurchaseOrderItemRow = typeof purchaseOrderItem.$inferSelect;

/**
 * "รับครบหรือยัง" — คำนวณสดทุกครั้ง ไม่เก็บเป็นคอลัมน์
 *   none    ยังไม่มีการรับของเลย
 *   partial รับมาบ้างแล้วแต่ยังไม่ครบทุก line
 *   full    ทุก line รับครบตามจำนวนที่สั่ง
 */
export type ReceivedStatus = 'none' | 'partial' | 'full';

/**
 * "ลงทะเบียนสินทรัพย์ไปแล้วแค่ไหน" — คนละคำถามกับ ReceivedStatus
 *   Warehouse ถาม "ของมาครบไหม"      -> ReceivedStatus
 *   คนทำทะเบียนถาม "ลงไปแล้วแค่ไหน"   -> RegistrationStatus
 */
export type RegistrationStatus = 'none' | 'partial' | 'full';

/** ยอดต่อ line ที่ใช้สรุปสถานะทั้งใบ */
export interface LineTotals {
  ordered: number;
  unitPrice: number;
  received: number;
  registered: number;
}

/** พารามิเตอร์ของหน้า list (page/limit ผ่าน validate มาแล้วจึงเป็น required) */
export interface FindPageParams {
  page: number;
  limit: number;
  search?: string;
}

/** สองสถานะที่แปะเพิ่มให้ทุกใบในหน้า list/detail */
export interface PoStatusFields {
  receivedStatus: ReceivedStatus;
  registrationStatus: RegistrationStatus;
}
