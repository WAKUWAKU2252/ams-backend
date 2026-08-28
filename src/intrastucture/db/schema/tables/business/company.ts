// ═══════════════════════════════════════════════════════════════════════════
// company — บริษัทในเครือ (0021)
//
// ทำไมเป็นตาราง ไม่ใช่ pgEnum: ในเครือมี 7 บริษัท (UBA, UBP, META INK GOLD,
// KAME CHEMICAL CAN, THAI TOP COAT GROUP, KRITTANAN HOLDINGS, VITA) และแต่ละ
// บริษัทมีคุณสมบัติที่ต้องเก็บมากกว่าชื่อ — ชื่อฐาน SAP, prefix เลขเอกสาร,
// เลขกลุ่มสินค้าที่ถือเป็นสินทรัพย์ enum เก็บได้แค่ค่าเดียวจึงไม่พอ
//
// sapDbName = NULL แปลว่าบริษัทนั้นไม่มี SAP ให้ sync (5 จาก 7 เป็นแบบนั้น)
// ตอบในตัวว่าทำไมถึงไม่มี poPrefix/grpoPrefix/itemGroups
//
// ⚠️ เลข itemGroups เป็นผังของแต่ละบริษัท ไม่ได้แปลว่าอะไรร่วมกัน:
//    UBA ใช้ 117 · UBP ใช้ 110 · และ UBA ไม่มีกลุ่ม 117 ในผังของ UBP เลย
//    ห้ามเอามารวมเป็นลิสต์เดียวยิงข้ามฐาน (ดู docs/multi-company-design.md)
// ═══════════════════════════════════════════════════════════════════════════
import { pgTable, varchar, boolean } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from '@intrastucture/db/schema/shared/iso-timestamp';

export const company = pgTable('company', {
  // รหัสสั้นที่คนอ่านออก ไม่ใช่ serial — ค่านี้ไปโผล่ใน URL, payload ของ Teams และ
  // export ที่ Finance เปิดด้วย Excel เลขเรียงจะอ่านไม่ออกและผูกข้ามเครื่องไม่ได้
  code: varchar({ length: 20 }).primaryKey().notNull(),
  name: varchar({ length: 100 }).notNull(),

  // ── สามคอลัมน์ล่างมีค่าเฉพาะบริษัทที่ต่อ SAP ──────────────────────────────
  // ชื่อฐานจริงใน SQL Server เช่น 'SBO_PRD_UBA' — connector ใช้เลือก pool
  // NULL = ไม่มี SAP, sync ข้ามบริษัทนี้ไปเลย
  sapDbName: varchar({ length: 50 }),
  // NNM1.BeginStr ของ ObjectCode 22 / 20 เช่น 'APO-' / 'AGP-'
  //
  // เก็บไว้เพื่อ "ตรวจ" ไม่ใช่เพื่อ "ประกอบ" — ตอน sync connector อ่าน BeginStr
  // จาก NNM1 ของแต่ละใบโดยตรง เพราะบริษัทหนึ่งมีได้หลาย series และค่าที่นี่เป็น
  // ค่าที่คนกรอก ถ้าเอามาต่อเลขตรง ๆ แล้วกรอกผิดจะได้เลขผิดทั้งชุดโดยไม่มีอะไรฟ้อง
  poPrefix: varchar({ length: 10 }),
  grpoPrefix: varchar({ length: 10 }),
  // OITM.ItmsGrpCod ที่ถือเป็นสินทรัพย์ของบริษัทนี้ คั่นด้วย comma เช่น '117'
  // ย้ายมาจาก env.SAP_ITEM_GROUPS ซึ่งเป็นค่าเดียวใช้ร่วมกันทุกบริษัท (ใช้ไม่ได้แล้ว)
  // ⚠️ ค่านี้ถูกต่อลง SQL ตรง ๆ — ฝั่งโค้ดต้องตรวจว่าเป็นจำนวนเต็มก่อนเสมอ
  itemGroups: varchar({ length: 50 }),

  isActive: boolean().default(true).notNull(),
  createdAt: isoTimestamp().default(sql`now()`).notNull(),
  updatedAt: isoTimestamp().default(sql`now()`).notNull(),
});
