// ประตูเดียวของ schema — ที่อื่นทั้งโปรเจกต์ import จาก '../../db/schema' เหมือนเดิม
// ไม่ต้องรู้ว่าตารางไหนอยู่ไฟล์ไหน (เดิมทุกอย่างอยู่ schema.ts ไฟล์เดียว 616 บรรทัด)
//
// ลำดับ export ไม่มีผลต่อ runtime แต่เรียงตาม flow ธุรกิจให้อ่านง่าย:
// PO -> รับของ -> ไฟล์แนบ -> คำขอ -> ข้อมูลอ้างอิง -> ตัวสินทรัพย์
//
// drizzle.config.ts ชี้มาที่โฟลเดอร์นี้ — ไฟล์ใหม่ที่ไม่ถูก re-export ที่นี่
// drizzle-kit จะมองไม่เห็น แล้วสั่ง DROP ตารางนั้นตอน push
export * from './legacy';
export * from './purchase';
export * from './grpo';
export * from './attachment';
export * from './asset-request';
export * from './master';
export * from './asset';
export * from './relations';
