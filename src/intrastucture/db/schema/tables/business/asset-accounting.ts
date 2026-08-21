// ═══════════════════════════════════════════════════════════════════════════
// มูลค่าทางบัญชี/ค่าเสื่อมของสินทรัพย์ — snapshot จาก SAP
//
// ต้นทางคือ ITM8 (ยอดสะสม) + ITM7 (พารามิเตอร์ค่าเสื่อม) ของ SAP ซึ่ง grain จริงของเขาคือ
// ItemCode × ปีบัญชี × DprArea (DprArea มีชุดเดียวคือ '01 Posting' จึงตัดออกได้)
//
// ── ★ เราเก็บ "ปีล่าสุดของแต่ละชิ้น" เท่านั้น = 1 แถวต่อสินทรัพย์ 1 ชิ้น
//
// SAP มี 25,816 แถวเพราะเก็บย้อนหลังทุกปีตั้งแต่ 1998 (เฉลี่ย ~9.5 ปีต่อชิ้น) ถ้าก๊อปมาทั้งหมด
// ตารางนี้จะใหญ่กว่าตาราง asset สิบเท่าเพื่อข้อมูลที่แทบไม่มีใครเปิดดู — คิวรีฝั่ง sync จึงใช้
// ROW_NUMBER() ... ORDER BY PeriodCat DESC แล้วเอา rn = 1
//
// ประวัติไม่ได้หายไปไหน มันยังอยู่ครบใน ITM8 ฝั่ง SAP — วันไหนต้องการย้อนหลังจริง ๆ ให้ถอด
// เงื่อนไข rn = 1 ออก เปลี่ยน PK เป็น (assetId, fiscalYear) แล้ว sync ใหม่ ไม่ต้องกู้อะไร
//
// ── สิ่งที่ต้องรู้ก่อนใช้ตัวเลขในตารางนี้
//
// 1) accumulatedDepreciation เป็น **ยอดสะสม** ไม่ใช่ค่าเสื่อมของงวด ห้าม SUM() ข้ามแถว
// 2) fiscalYear ไม่ใช่ "ปีนี้" เสมอไป — ของที่ตัดจำหน่ายไปแล้วยอดจะค้างที่ปีสุดท้ายของมัน
//    (ปี 2026 มีตัวเลขอยู่ 2,058 ชิ้นจาก 2,726) ค่านี้จึงต้องแสดงคู่กับตัวเลขเสมอ ไม่ใช่ซ่อนไว้
// 3) netBookValue ไม่มีในตารางนี้โดยตั้งใจ — SAP เองก็ไม่ได้เก็บ มันคำนวณตอนเปิดรายงาน
//    ให้หน้าจอลบ bookedCost − accumulatedDepreciation เอง (ยืนยันจากหน้าจอจริง:
//    90,000 − 11,779.715768 = 78,220.284232)
// 4) bookedCost (APC) **ไม่ใช่** asset.acquisitionCost — ตัวหลังคือราคาที่เสนอตอนขอซื้อ
//    (PO_FLOW) หรือยอดใบกำกับ A/P (SAP_LEGACY) คนละค่ากันคนละที่มา ห้ามเอามาแทนกัน
// 5) usefulLifeMonths หน่วยเป็น **เดือน** ตามที่ SAP เก็บ (60 = 5 ปี) — ไม่แปลงหน่วยเอง
//    ตามกติกาของโมดูลนี้: ดึงอย่างเดียว ไม่คำนวณเอง
//
// ── ที่จงใจไม่มีคอลัมน์ให้
//
// unplannedDepreciation / specialDepreciation / writeUpValue — วัดแล้วเป็น 0 ทั้ง 25,816 แถว
// แต่ connector ต้องเช็คทุกรอบว่ายัง 0 อยู่ ถ้าเจอค่าที่ไม่ใช่ 0 ให้บันทึกเป็น error ไม่ข้ามเงียบ
// (ไม่งั้นวันที่บัญชีตัดด้อยค่า ยอดสะสมของเราจะต่ำกว่าจริงโดยไม่มีอะไรฟ้อง)
//
// ── ไม่มี CHECK ว่ายอดต้องเป็นบวก
//
// ตัวอย่างที่สำรวจมาเป็นบวกทั้งหมด แต่ยังไม่ได้สแกนครบทุกแถว และมีรายงานว่าเคยเห็นเลขลบ
// ถ้าใส่ CHECK ไว้แล้วเจอของจริงเป็นลบ sync จะพังทั้งรอบแทนที่จะเก็บข้อมูลได้ — ให้เก็บก่อน
// แล้วให้ connector เป็นคนรายงานความผิดปกติ ค่อยตัดสินใจทีหลังว่าเลขลบแปลว่าอะไร
// ═══════════════════════════════════════════════════════════════════════════
import { pgTable, integer, numeric, varchar, date, foreignKey, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from '@intrastucture/db/schema/shared/iso-timestamp';
import { asset } from './asset';

export const assetAccounting = pgTable(
  'asset_accounting',
  {
    // grain = สินทรัพย์หนึ่งชิ้น (ไม่ใช่ชิ้น × ปี) จึงเป็น PK ได้ตรง ๆ ไม่ต้องมี id ของตัวเอง
    assetId: integer().primaryKey().notNull(),
    // ตัวเลขทั้งแถวเป็นของปีบัญชีไหน — SAP เก็บ PeriodCat เป็นสตริง '2026' เราแปลงเป็น int
    // เพื่อให้เรียง/หาช่วงปีได้ถูก (เป็นการเปลี่ยนชนิด ไม่ใช่การคำนวณค่า)
    fiscalYear: integer().notNull(),
    // APC — มูลค่าทุนทางบัญชี
    bookedCost: numeric({ mode: 'number' }),
    // APCHist — ยอดตามราคาทุนเดิม ยังไม่ได้ตรวจว่าต่างจาก APC เมื่อไหร่
    bookedCostHistorical: numeric({ mode: 'number' }),
    // OrDpAcc — ค่าเสื่อมสะสม (สะสม ไม่ใช่ของงวด ดูข้อ 1 ที่หัวไฟล์)
    accumulatedDepreciation: numeric({ mode: 'number' }),
    // SalvageVal — 1.00 บาทตามธรรมเนียมไทย ค่าเสื่อมจะตันที่ APC − SalvageVal ไม่ใช่ที่ APC
    salvageValue: numeric({ mode: 'number' }),
    usefulLifeMonths: integer(),
    remainingLifeMonths: integer(),
    // DprType เก็บดิบ เช่น '01 Straight' — ชื่อเต็มอยู่ที่ ODTP.DprMeth ฝั่ง SAP
    depreciationMethod: varchar({ length: 50 }),
    // ⚠️ คนละตัวกับ asset.acquisitionDate ซึ่งเป็นวันใบกำกับ — สองวันนี้ต่างกันได้เป็นสิบปี
    depreciationStart: date(),
    depreciationEnd: date(),
    // ดึงมาล่าสุดเมื่อไหร่ — คนละเรื่องกับ fiscalYear ที่บอกว่าตัวเลข "เป็นของปีไหน"
    // (ดึงวันนี้แล้วได้ตัวเลขของปี 2013 เป็นเรื่องปกติสำหรับของที่ตัดจำหน่ายไปแล้ว)
    // ไม่มีแถวในตารางนี้เลย = ชิ้นนั้นยังไม่เคยถูก sync ข้อมูลบัญชี ไม่ต้องมีคอลัมน์บน asset
    syncedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.assetId],
      foreignColumns: [asset.id],
      name: 'fk_asset_accounting_asset',
    }).onDelete('cascade'),
    // "ของชิ้นไหนตัวเลขค้างอยู่ปีเก่า" เป็นคำถามที่บัญชีถามจริง และเป็นตัวชี้ว่าของถูกตัด
    // จำหน่ายไปแล้วหรือ sync มีปัญหา
    index('idx_asset_accounting_fiscal_year').on(table.fiscalYear),
  ],
);
