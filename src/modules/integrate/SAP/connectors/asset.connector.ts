// ═══════════════════════════════════════════════════════════════════════════
// connector ของสินทรัพย์เก่า — ประตูหลังของระบบ
//
// PO/GRPO ตอบคำถาม "ของที่กำลังจะเข้ามา" ส่วนตัวนี้ตอบ "ของที่อยู่ในบัญชีมาก่อนแล้ว"
// ราว 2,300 ชิ้นที่ Finance ลงทะเบียนใน SAP ตรง ๆ โดยไม่เคยผ่าน AMS — และจะยังมีเข้ามา
// เรื่อย ๆ ในอนาคตทุกครั้งที่มีคนออกเลขสินทรัพย์นอกระบบ ตัวนี้จึงไม่ใช่สคริปต์นำเข้า
// ครั้งเดียวจบ แต่เป็น sync ที่ต้องรันซ้ำได้ตลอดไป
//
// ── สามข้อที่ต่างจากอีกสอง connector
//
// 1) ไม่มี backfill — OITM เป็น item master ไม่ใช่กองเอกสารที่โตตามเวลา "ประวัติ" ของมัน
//    คือสถานะปัจจุบัน ดึงเต็มทุกรอบ (~2,300 แถว) ยังเบากว่าหน้าต่างเดียวของ PO เสียอีก
//    fetchFloor จึงคืน null เสมอ แล้ว engine จะปักพื้นไว้ที่ "ตอนนี้" และสลับเป็น
//    INCREMENTAL ตั้งแต่รอบแรก (ทางที่มีอยู่แล้วสำหรับเคส "ไม่มีอดีตให้ตามเก็บ")
//    ผลข้างเคียงคือ fetch ได้ windows มาแต่ไม่ใช้ — ตั้งใจ ไม่ใช่ลืม
//
// 2) เขียนลงตาราง asset ตรง ๆ ไม่ผ่าน purchase_order/grpo — แถวที่ได้เป็น origin
//    'SAP_LEGACY' ซึ่ง ck_asset_origin_chain บังคับให้โซ่ PO ว่างทั้งชุด
//
// 3') ดึงสองคิวรีต่อรอบ ไม่ใช่หนึ่ง — ทะเบียนสินทรัพย์ (ทุก ItemCode ในกลุ่มที่ไม่ใช่ตัวเลขล้วน)
//    กับรหัสจัดซื้อ (ตัวเลขล้วน เช่น '1216401') ชุดหลังไม่ใช่ของสักชิ้น ใช้เป็น "ตารางค้นหา"
//    สำหรับเติมชิ้นที่ยังไม่ได้ออกเลขเท่านั้น ห้ามสร้าง asset จากมัน
//    (ดูสายที่สี่ใน apply และเหตุผลเต็มที่ purchasingItemAll() ใน queries.ts)
//
//    ★ SQL ไม่ได้กรองด้วย "รูปแบบเลขสินทรัพย์" อีกแล้ว — ของที่ตกกติกาใน WHERE จะหายเงียบ
//      ซึ่งเคยทำให้สินทรัพย์จริง 396 ชิ้นไม่เข้าระบบ ตอนนี้ดึงมาหมดแล้วติดธงที่นี่แทน
//
// 3) จุดเชื่อมคือ assetNumber ไม่ใช่คีย์ของ SAP — เพราะเลขสินทรัพย์คือสิ่งเดียวที่ทั้ง
//    สองทางเข้ามีร่วมกัน ของที่ลงทะเบียนผ่าน AMS สุดท้าย Finance ก็ออกเลขให้ใน SAP
//    เหมือนกัน แล้วจะโผล่ในผลลัพธ์ของ connector นี้ด้วย ถ้า insert ทื่อ ๆ ของชิ้นเดียว
//    จะกลายเป็นสองแถว — upsert ที่ assetNumber คือสิ่งที่ทำให้สองทางเข้ามาเจอกันพอดี
//
// ── ใครเป็นเจ้าของคอลัมน์ไหน
//
// กติกาของแถว SAP_LEGACY: **ข้อมูลที่มาจาก SAP ให้ SAP ดูแล** แก้ที่ SAP เมื่อไหร่
// รอบ sync ถัดไปต้องตามมาเสมอ ไม่ใช่ค้างค่าเก่าไว้เพราะเคยมีคนแตะที่ฝั่ง AMS
//
// คอลัมน์ที่ SAP เป็นเจ้าของ: acquisitionDate, sapCreatedDate, assetClass, categoryId, departmentId,
// employeeId, locationId, uom, serialNumber — ทั้งหมดใช้กติกาเดียวกันคือ
// "SAP มีค่า → ใช้ของ SAP / SAP ไม่มีค่า → คงของเดิมไว้"
//
// ── status: SAP เป็นเจ้าของ **แค่แกน Active↔Inactive** ไม่ใช่ทั้งคอลัมน์
//
// เดิมอ่าน OITM.validFor มาตั้งตอน INSERT แล้วไม่เคยอัปเดตอีกเลย ผลคือของที่บัญชี
// ตัดจำหน่ายใน SAP ไปแล้วยังขึ้น Active ใน AMS ตลอดกาล ซึ่งเป็นคำถามหลักของทะเบียน
// สินทรัพย์พอดี — ตอนนี้ทับให้ตามทุกรอบแล้ว ทั้งแถว SAP_LEGACY และ PO_FLOW
//
// ★ **ทับเสมอ ไม่มีเงื่อนไข — SAP เป็นเจ้าของสถานะ 100%**
//
//   เดิมทับเฉพาะเมื่อค่าเดิมเป็น 'Active'/'Inactive' เพื่อกันไม่ให้ของที่คนตั้งว่า
//   "ส่งซ่อมอยู่" เด้งกลับ แต่กติกานั้นแลกมาด้วยประตูหลัง: แถวที่ถือค่าอื่นจะหยุดรับ
//   ค่าจาก SAP ถาวรโดยไม่มีอะไรฟ้อง
//
//   ตัดสินใจแล้วว่าเอาความตรงกับ SAP มาก่อน — สามค่าที่เหลือถูกถอดออกจากทางเดินทุกเส้น
//   แล้ว (ดู sapStatusRule) ถ้าวันหนึ่งต้องมี "ส่งซ่อม/สูญหาย/ตัดจำหน่าย" จริง
//   ต้องเป็นคอลัมน์ใหม่แยกต่างหาก ไม่ใช่มาเบียดแกนที่ SAP เป็นเจ้าของ
//
// ★ **acquisitionCost ถูกถอดออกจากชุดนี้แล้ว** — เดิมเอา SUM(PCH1.LineTotal) มาใส่ ซึ่งผิด
//   โดยโครงสร้าง: รหัสสินทรัพย์หนึ่งตัวอยู่บนใบกำกับได้หลายบรรทัด (COM-220-21-004 มี 3
//   บรรทัด บรรทัดละ 1 ตัว ราคาละ 329,000) การรวมจึงได้ 987,000 ทั้งที่ของชิ้นนั้นราคา
//   329,000 — วัดแล้วเพี้ยนแบบนี้ 61 แถว หนักสุดต่างจากราคาทุน 941,777
//
//   ราคาที่ถูกต้องอยู่ที่ asset_accounting.bookedCost (ITM8.APC ถอยไป ACQ1) อยู่แล้ว
//   ซึ่งครอบ 3,490 จาก 3,510 แถว = 99.4% ไม่มีเหตุให้เก็บเลขที่สองที่ขัดกันเองอีกช่อง
//   ตอนนี้ acquisitionCost จึงเป็นของแถว PO_FLOW ล้วน ๆ ตามเจตนาเดิมของคอลัมน์
//   ("ราคาทุนที่เสนอตอนขอลงทะเบียน" — ดู asset.ts)
//
// ที่ไม่ทับด้วยคือของที่ SAP ไม่มีให้ตั้งแต่แรก: รูป ห้องย่อย พิกัดหมุด
// สองอันหลังเป็นข้อมูลที่เกิดจากการเดินสำรวจ ซึ่ง SAP ไม่มีทางรู้
//
// ── QR เป็นข้อยกเว้นที่สาม: AMS ประกอบเอง ไม่ได้มาจาก SAP แต่ทับเสมอ
//
// ค่ามาจาก assetQrUrl(companyCode, assetNumber) = APP_BASE_URL + บริษัท + เลขสินทรัพย์
// ต้องเติมตอน sync เพราะของเก่า 2,700+ ชิ้นต้องติดสติกเกอร์เหมือนของที่ลงทะเบียนผ่าน AMS
//
// ทับเสมอเพราะมันเป็นค่า derive ที่ผูกกับ config ไม่ใช่ข้อมูลที่ใครกรอก — ถ้าตรึงค่าแรกไว้
// วันที่ APP_BASE_URL ยังเป็น localhost จะได้ QR ที่ใช้ไม่ได้ทั้งทะเบียนแบบแก้ไม่ได้อีกเลย
// ⚠️ ตั้ง APP_BASE_URL ให้เป็นโดเมนจริงก่อนพิมพ์สติกเกอร์ล็อตแรก (ดู config/env.ts)
//
// ⚠️ ผลที่ตามมาที่ต้องรู้: การแก้ที่ตั้ง/ผู้ถือครองของแถว SAP_LEGACY ผ่านหน้าจอ AMS
// จะถูกดึงกลับในรอบ sync ถัดไป — ของสองอย่างนี้ต้องแก้ที่ SAP เป็นหลัก
//
// ── แถว PO_FLOW: SAP เป็นเจ้าของแค่สามคอลัมน์ ไม่ใช่ทั้งแถว
//
// ของที่ลงทะเบียนผ่าน AMS เอง AMS เป็นเจ้าของแถวโดยปริยาย แต่ **หมวด/หน่วยนับ/AssetClass
// ไม่เคยมีในทาง PO เลย** — สามค่านี้เกิดที่ OITM ตอน Finance ออกเลขสินทรัพย์ให้ใน SAP
// เท่านั้น เดิม connector ข้ามทั้งแถวจึงเป็น NULL ค้างตลอดกาล (วัดเมื่อ 2026-08-20:
// PO_FLOW 26 แถว มี uom/categoryId/assetClass ครบ 0 แถว ส่วน SAP_LEGACY เต็มเกือบ 100%)
//
// จึงเปลี่ยนจาก "ข้ามทั้งแถว" เป็น "เขียนเฉพาะคอลัมน์ที่ SAP เป็นเจ้าของจริง":
//
//   SAP ชนะบน PO_FLOW : assetClass, categoryId, uom, sapCreatedDate, status ← ห้าตัวนี้เท่านั้น
//                       (sapCreatedDate เพิ่มมาทีหลัง: เป็นวันที่ SAP สร้างแถว OITM ซึ่ง
//                        AMS ไม่มีทางรู้เอง และไม่มีใครฝั่ง AMS กรอกทับได้ จึงไม่ชนกับใคร
//                        status เพิ่มทีหลังเช่นกัน และมีกติกาของตัวเองอยู่ข้างบน — ของที่
//                        ลงทะเบียนผ่าน AMS แล้วบัญชีตัดจำหน่ายใน SAP ต้องสะท้อนกลับมา
//                        เหมือนกัน ไม่มีเหตุให้แยกกฎกับแถว SAP_LEGACY)
//   AMS ชนะเสมอ       : serialNumber, description, locationId, subLocationId, employeeId,
//                       departmentId, acquisitionCost/Date, รูป, QR, พิกัดหมุด
//
// ★ ห้ามขยายชุดสามคอลัมน์นี้โดยไม่คิดให้จบ โดยเฉพาะ departmentId/employeeId/locationId:
//   บนแถว PO_FLOW ค่าพวกนี้มาจากผู้ขอ/ผู้อนุมัติในใบคำขอ ซึ่งเป็นความจริงที่ AMS รู้ดีกว่า
//   SAP — ปลดล็อกเมื่อไหร่ งานที่คนกรอกจะถูกดึงกลับเป็นค่าของ SAP ทุกนาทีที่ scheduler เดิน
//   (ต่างจาก SAP_LEGACY ที่ SAP เป็นความจริงตั้งต้นของทั้งแถว)
// ═══════════════════════════════════════════════════════════════════════════
import { and, eq, inArray, isNotNull, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import {
  asset,
  assetAccounting,
  assetLocation,
  category,
  department,
  employee,
  employeeCompany,
  purchaseOrderItem,
  sapAssetSync,
  sapAssetSyncEvent,
  sapAssetUnknownNumber,
} from '@intrastucture/db/schema';
import { sapQuery } from '@intrastucture/sap/client';
import { legacyAssetAll, purchasingItemAll } from '@intrastucture/sap/queries';
import { lockKeyFor } from '@/modules/integrate/SAP/company.util';
import type { SyncConnector, Tx, PullResult, SyncState } from '@/modules/integrate/SAP/sync.engine';
import { emptyResult } from '@/modules/integrate/SAP/sync.engine';
import { requireRow } from '@common/db-result';
import { isAssetNumber } from '@common/asset-number';
import { assetQrUrl } from '@common/app-url';
import { toIso, toDateOnly, toNum, toStr, maxIso, chunk, nowIso } from '@/modules/integrate/SAP/sync.util';

/** หนึ่งแถว = สินทรัพย์ × ใบกำกับ (ไม่มีใบก็ยังได้หนึ่งแถวจาก LEFT JOIN) */
export type LegacyAssetRow = {
  assetNumber: string;
  description: string | null;
  /** OITM.validFor — 'Y' = ยังใช้งานอยู่ในทะเบียนของ SAP */
  isActive: string | null;
  createDate: Date | null;
  updateDate: Date | null;
  /** '<รหัสบัญชี>-<0/1>-<cost center>' เช่น '1216401-0-775' — ดูหมายเหตุที่ queries.ts */
  assetClass: string | null;
  uom: string | null;
  serialNumber: string | null;
  /** OITM.Location → OLCT.Code (0 หรือ null = ไม่ได้ระบุ) */
  locationCode: number | null;
  /** OITM.Employee → OHEM.empID (0 หรือ null = ไม่ได้ระบุ) */
  employeeCode: number | null;
  acqDate: Date | null;
  vendor: string | null;
  invoiceNo: number | null;
  // ── ชุดบัญชี (ITM8 + ITM7) มาในคิวรีเดียวกัน แล้วแยกลง asset_accounting ทีหลัง
  //    ค่าเหล่านี้ซ้ำเหมือนกันทุกแถวของสินทรัพย์ชิ้นเดียวกัน (ที่ต่างคือฝั่งใบกำกับ)
  //    ทั้งชุดเป็น null พร้อมกันได้ = ชิ้นนั้นยังไม่มียอดบัญชีใน SAP
  /** ITM8.PeriodCat — SAP เก็บเป็นสตริงปีสี่หลัก '2026' */
  fiscalYear: string | null;
  /** ITM8.APC — **ยอดยกมาต้นปีบัญชี** ปีที่ซื้อจึงเป็น 0 เสมอ (ดู resolveBookedCost) */
  bookedCost: number | null;
  /** SUM(ACQ1.LineTotal) ต่อชิ้น — ยอดรวมรายการซื้อที่เคยเกิด ใช้ถอยไปหาเมื่อ APC ยังเป็น 0 */
  acquisitionPostedTotal: number | null;
  bookedCostHistorical: number | null;
  accumulatedDepreciation: number | null;
  salvageValue: number | null;
  /** หกช่องนี้ไม่มีที่เก็บใน ams_db — ดึงมาตรวจว่ายังเป็น 0 อยู่เท่านั้น */
  unplannedDep: number | null;
  specialDep1: number | null;
  specialDep2: number | null;
  specialDep3: number | null;
  writeUp: number | null;
  appreciation: number | null;
  usefulLifeMonths: number | null;
  remainingLifeMonths: number | null;
  depreciationMethod: string | null;
  depreciationStart: Date | null;
  depreciationEnd: Date | null;
};

/** ชุดบัญชีที่ยุบแล้ว — หยิบจากแถวแรกของสินทรัพย์ชิ้นนั้น (ทุกแถวเหมือนกัน) */
type AccountingSnapshot = Pick<
  LegacyAssetRow,
  | 'fiscalYear'
  | 'bookedCost'
  | 'bookedCostHistorical'
  | 'accumulatedDepreciation'
  | 'salvageValue'
  | 'unplannedDep'
  | 'specialDep1'
  | 'specialDep2'
  | 'specialDep3'
  | 'writeUp'
  | 'appreciation'
  | 'usefulLifeMonths'
  | 'remainingLifeMonths'
  | 'depreciationMethod'
  | 'depreciationStart'
  | 'depreciationEnd'
>;

/**
 * รหัสจัดซื้อในกลุ่มเดียวกับสินทรัพย์ = **ตัวเลขล้วน** เท่านั้น — ดู purchasingItemAll()
 *
 * ไม่ใช่ "ของหนึ่งชิ้น" แต่เป็นรหัสบัญชี/หมวดที่ของหลายร้อยชิ้นใช้ร่วมกัน จึงเอามาได้แค่
 * ความจริงระดับหมวด ไม่มีวันที่ ไม่มีราคา ไม่มี serial
 */
export type PurchasingItemRow = {
  itemCode: string;
  description: string | null;
  assetClass: string | null;
  uom: string | null;
};

/** ก้อนที่ fetch คืน — สองชุดคนละ grain ที่ apply ใช้คนละทาง (ห้ามยุบรวมเป็นอาร์เรย์เดียว) */
export type LegacyAssetPull = {
  assets: LegacyAssetRow[];
  purchasing: PurchasingItemRow[];
};

/** สินทรัพย์หนึ่งชิ้นหลังยุบใบกำกับหลายใบเข้าด้วยกันแล้ว */
type LegacyAsset = {
  assetNumber: string;
  description: string | null;
  /** สตริงเต็มจาก SAP — เก็บดิบไว้เป็นหลักฐานของสองค่าที่ derive ออกมาข้างล่าง */
  assetClass: string | null;
  categoryCode: string | null;
  departmentCode: string | null;
  uom: string | null;
  serialNumber: string | null;
  sapLocationId: number | null;
  employeeCode: number | null;
  status: 'Active' | 'Inactive';
  acquisitionDate: string | null;
  /** OITM.CreateDate — วันที่ Finance ออกเลขให้ใน SAP (คนละตัวกับวันตั้งหนี้) */
  sapCreatedDate: string | null;
  /** null = SAP ยังไม่มียอดบัญชีให้ชิ้นนี้ (ไม่มีแถวใน ITM8) */
  accounting: AccountingSnapshot | null;
};

/** id ฝั่ง AMS ที่ resolve ได้แล้ว — แยกจาก LegacyAsset เพราะต้องรู้จัก master ก่อนถึงจะเติมได้ */
type ResolvedAsset = LegacyAsset & {
  categoryId: number | null;
  departmentId: number | null;
  locationId: number | null;
  employeeId: number | null;
};

const INSERT_CHUNK = 500;
/** จำนวนรหัสที่ log ออกมาให้ดูตอนเจอเลขไม่เข้าสคีมา — พอให้เห็นตัวอย่าง ไม่ท่วมจอ */
const OFF_SCHEME_LOG_SAMPLE = 10;
const LOOKUP_CHUNK = 1000;

/**
 * ที่ตั้งตั้งต้นของของเก่า — ยังไม่มีใครไปตามหาว่าของจริงวางอยู่ห้องไหน
 *
 * asset.locationId เป็น NOT NULL โดยตั้งใจ (ของที่ไม่รู้ว่าอยู่ไหนคือของที่หายไปแล้ว
 * ในทางปฏิบัติ) จึงใช้แถวพักแทนการเปิดให้เป็น NULL — ได้ผลเท่ากันแต่ทาง PO flow
 * ยังสร้างของที่ไม่ระบุที่ตั้งไม่ได้อยู่ และ 2,325 ชิ้นนี้กลายเป็นคิวงานที่ query ได้ตรง ๆ
 * ว่า "เหลือของที่ยังไม่รู้ที่ตั้งกี่ชิ้น" (แนวเดียวกับแผนก '-1' ที่ import employee ใช้)
 */
const UNASSIGNED_LOCATION = 'ยังไม่ระบุที่ตั้ง';

/**
 * แกะ AssetClass ออกเป็นสองคีย์ที่ใช้ resolve master
 *
 *   '1216401-0-775'  →  categoryCode '1216401' (รหัสบัญชี)  +  departmentCode '775' (cost center)
 *
 * ท่อนกลาง (0 = สำนักงาน / 1 = โรงงาน) ทิ้งโดยตั้งใจ: มันซ้ำกับ OITM.AssetGroup และ
 * สองที่นั้นขัดกันเองหลายแถว (เช่น '...-0-774' แต่ AssetGroup = โรงงาน) ไม่มีตัวไหน
 * เชื่อได้พอจะเอาไปตัดสินใจ ใครอยากรู้ให้อ่านจาก assetClass ที่เก็บดิบไว้เอง
 *
 * รูปแบบไม่ครบสามท่อน = คืน null ทั้งคู่ ปล่อยให้ทั้งหมวดและแผนกว่างไว้ ดีกว่าเดา
 * จากท่อนที่มี — ค่าที่ผิดจะไหลไปเป็นยอดรวมในรายงานบัญชีโดยไม่มีอะไรฟ้อง
 */
function parseAssetClass(raw: string | null): { categoryCode: string | null; departmentCode: string | null } {
  const parts = (toStr(raw) ?? '').split('-');
  if (parts.length !== 3) return { categoryCode: null, departmentCode: null };
  return { categoryCode: toStr(parts[0]), departmentCode: toStr(parts[2]) };
}

/**
 * จำนวนแถวที่คำสั่งนั้นแตะจริง — ใช้นับผลหลังใส่ guard (ดู sapLegacyChanged)
 *
 * ★ ต้องอ่านจากผลลัพธ์ ไม่ใช่นับจากจำนวนที่ส่งเข้าไป: ตั้งแต่มี guard สองค่านี้ไม่เท่ากันแล้ว
 *   ส่งไป 2,700 แถวแต่เขียนจริง 3 แถวเป็นเรื่องปกติ
 *
 * ทั้งสอง driver คืน rowCount มาให้เหมือนกัน (node-postgres บน production / PGlite ในเทสต์
 * — วัดแล้วมีทั้ง rowCount และ affectedRows ค่าตรงกัน) แต่ชนิดฝั่ง drizzle ไม่การันตี
 * จึงอ่านแบบเผื่อไว้แทนการ cast ทิ้ง ค่าที่อ่านไม่ได้นับเป็น 0 ดีกว่ารายงานเกินจริง
 */
function rowsAffected(res: unknown): number {
  const n = (res as { rowCount?: unknown; affectedRows?: unknown } | null)?.rowCount;
  if (typeof n === 'number') return n;
  const alt = (res as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof alt === 'number' ? alt : 0;
}

/** 0 กับ null มีความหมายเดียวกันสำหรับ FK ฝั่ง SAP — SAP ใช้ 0 แทน "ไม่ได้เลือก" */
const toRef = (n: number | null): number | null => (n == null || n <= 0 ? null : n);

/**
 * สถานะที่ SAP มีสิทธิ์เขียน — **SAP ชนะเสมอ ไม่มีเงื่อนไข**
 *
 * OITM.validFor พูดได้แค่ 'Active'/'Inactive' และตั้งแต่ถอดสามค่าที่เหลือออกจากทางเดิน
 * ทุกเส้น (ตัวกรอง / ป้ายบนจอ / union ของ assetInventoryQuery) แกนนี้ก็เหลือสองค่าที่
 * SAP พูดถึงล้วน ๆ — ทับได้ตรง ๆ ไม่ต้องมีเงื่อนไขอะไรกั้น
 *
 * ── เคยเป็น CASE WHEN current IN ('Active','Inactive') THEN incoming ELSE current END
 *
 * ★ เงื่อนไขนั้นคือ "ประตูหลัง" ที่ทำให้ข้อมูลหลุดจาก SAP ได้ถาวร: แถวไหนถูกตั้งเป็น
 *   'Under Maintenance'/'Lost'/'Disposed' ด้วยทางไหนก็ตาม จะหยุดรับค่าจาก SAP ตั้งแต่
 *   วินาทีนั้นไปตลอดกาล โดยไม่มีอะไรฟ้อง — วัด 2026-09-07: ไม่มีสักแถวที่ใช้สามค่านั้น
 *   (Active 2,825 / Inactive 721 / อีกสามค่า 0) กติกานี้จึงกันของที่ไม่มีอยู่จริง
 *   แลกกับความเสี่ยงที่ของจริงจะเพี้ยน
 *
 * ★ ตัดสินใจแล้วว่า **SAP เป็นเจ้าของสถานะ 100%** ถ้าวันหนึ่งธุรกิจต้องการ "ส่งซ่อม/
 *   สูญหาย/ตัดจำหน่าย" จริง ต้องเป็นคอลัมน์ใหม่แยกต่างหาก ห้ามมาเบียดแกนนี้
 *
 * ★ ยังคงเป็นฟังก์ชันไว้ (ไม่ inline `incoming` ทิ้ง) เพราะกฎนี้ถูกใช้สี่ที่ที่เขียนคนละภาษา
 *   — onConflictDoUpdate ของสายที่ 1, UPDATE...FROM VALUES ของสายที่ 2 และ 3, และ
 *   rowChanged ที่ต้องเป็นนิพจน์เดียวกับใน SET เป๊ะ แก้ที่เดียวแล้วได้ครบทุกที่
 *
 * @param incoming ค่าที่ SAP ส่งมารอบนี้ — `excluded."status"` หรือ `v."status"`
 * @param _current ค่าเดิมในแถว — ไม่ได้ใช้แล้ว คงพารามิเตอร์ไว้เพื่อไม่ต้องแก้ผู้เรียกทั้งสี่ที่
 */
const sapStatusRule = (incoming: SQL, _current: SQL): SQL => incoming;

/**
 * ที่ตั้งที่ SAP ให้มา — "ไม่ระบุ" เดินทางมาถึงในรูปแถวพัก ไม่ใช่ NULL จึงต้องเทียบกับ id ของมัน
 * (locationId เป็น NOT NULL เขียน COALESCE ตรง ๆ ไม่ได้ — ดูเหตุผลเต็มที่ onConflictDoUpdate)
 */
const sapLocationRule = (incoming: SQL, current: SQL, unassignedId: number): SQL =>
  sql`CASE WHEN ${incoming} = ${unassignedId} THEN ${current} ELSE ${incoming} END`;

/**
 * แถวนี้จะเปลี่ยนค่าจริงไหม — ใช้ต่อท้าย WHERE ของสายที่ 1–2 เพื่อไม่เขียนทับของที่เหมือนเดิม
 *
 * ── ทำไมต้องมี
 *
 * pg ใช้ MVCC: UPDATE ที่เขียนค่าเดิมเป๊ะก็ยังสร้าง row version ใหม่ทั้งแถวแล้วทิ้งของเก่า
 * เป็น dead tuple ไม่มีการเช็คให้ว่า "ค่าเหมือนเดิม ไม่ต้องเขียนก็ได้"
 *
 * สายที่ 1–2 เขียนทับ ~2,700 แถวทุกรอบแม้ SAP ไม่ได้แก้อะไรเลย วัดจาก pg_stat_user_tables
 * (2026-09-04): asset มีของจริง 3,547 แถว แต่ถูก UPDATE ไปแล้ว 30,064 ครั้ง = 8.5 เท่า
 * ส่วน purchase_order ที่มี guard อยู่แล้วเป็น 217/204 ≈ 1:1
 *
 * ผลคือ txMs ของ asset แตะ 3,500 ms ซึ่งเป็นช่วงที่ ams_db ถูกจับล็อกจริง และ
 * asset.updatedAt ขยับทุกรอบจนตอบไม่ได้ว่า "แถวนี้เปลี่ยนล่าสุดเมื่อไหร่"
 *
 * ── กติกาการเขียน
 *
 * ★ ทุกบรรทัดต้องเป็น **นิพจน์เดียวกับที่อยู่ใน SET เป๊ะ** ไม่ใช่เขียนย่อเอง — เงื่อนไขที่
 *   ไม่ตรงกับค่าที่จะเขียนจริงคือแถวที่ควรอัปเดตแล้วไม่ถูกแตะ (หรือกลับกัน)
 *
 * ★ ต้องครบทุกคอลัมน์ใน SET ยกเว้น updatedAt — ตกไปช่องเดียว การแก้ที่ SAP ในช่องนั้น
 *   จะไม่มีวันไหลมาถึง AMS และไม่มีอะไรฟ้อง
 *
 * ★ ห้ามใส่ updatedAt: มันคือ now() ซึ่งต่างเสมอ ใส่แล้วทุกแถวผ่าน guard = ไม่มี guard
 *
 * ★ ต้องใช้ IS DISTINCT FROM ไม่ใช่ <> — คอลัมน์เกือบทั้งหมด nullable และ `x <> NULL`
 *   คืน NULL ซึ่งใน WHERE ถือเป็นเท็จ แถวที่ควรเข้าจะหลุดออกเงียบ ๆ
 *
 * @param cur  ตัวอ้างค่าปัจจุบันในแถว — คอลัมน์ของ asset (สาย 1) หรือ `a."x"` (สาย 2)
 * @param inc  ตัวอ้างค่าที่จะเขียน — `excluded."x"` (สาย 1) หรือ `v."x"` (สาย 2)
 */
const sapLegacyChanged = (
  cur: (col: string) => SQL,
  inc: (col: string) => SQL,
  unassignedId: number,
): SQL =>
  sql`(
       ${cur('acquisitionDate')} IS DISTINCT FROM ${inc('acquisitionDate')}
    OR ${cur('sapCreatedDate')}  IS DISTINCT FROM ${inc('sapCreatedDate')}
    OR ${cur('assetClass')}      IS DISTINCT FROM COALESCE(${inc('assetClass')},   ${cur('assetClass')})
    OR ${cur('categoryId')}      IS DISTINCT FROM COALESCE(${inc('categoryId')},   ${cur('categoryId')})
    OR ${cur('departmentId')}    IS DISTINCT FROM COALESCE(${inc('departmentId')}, ${cur('departmentId')})
    OR ${cur('employeeId')}      IS DISTINCT FROM COALESCE(${inc('employeeId')},   ${cur('employeeId')})
    OR ${cur('uom')}             IS DISTINCT FROM COALESCE(${inc('uom')},          ${cur('uom')})
    OR ${cur('serialNumber')}    IS DISTINCT FROM COALESCE(${inc('serialNumber')}, ${cur('serialNumber')})
    OR ${cur('qrCode')}          IS DISTINCT FROM ${inc('qrCode')}
    OR ${cur('locationId')}      IS DISTINCT FROM ${sapLocationRule(inc('locationId'), cur('locationId'), unassignedId)}
    OR ${cur('status')}          IS DISTINCT FROM ${sapStatusRule(inc('status'), cur('status'))}
  )`;

/**
 * ยุบหลายใบกำกับให้เหลือชิ้นละแถว
 *
 * ราคา = ผลรวมทุกใบ ไม่ใช่ใบล่าสุด: รหัสที่อยู่บนหลายใบคือของเหมา/งานโครงการ
 * (เช่น 'เดิน Infrastructure Access Point' ที่ทยอยวางบิลเป็นงวด) มูลค่าที่ลงบัญชีจริง
 * คือยอดรวมทั้งงาน หยิบใบเดียวมาจะได้ราคาต่ำกว่าความจริงแบบเงียบ ๆ
 *
 * วันที่ตั้งหนี้ = ใบแรกสุด / ไม่มีใบกำกับเลย → NULL **ไม่ถอยไปใช้ CreateDate อีกแล้ว**
 * วันสร้างใน SAP ไปอยู่คอลัมน์ sapCreatedDate ของตัวเอง คอลัมน์เดียวจึงมีความหมายเดียว
 * (ของเดิมปนกันสองความหมายโดยไม่มีอะไรบอกว่าแถวไหนเป็นอันไหน)
 */
function collapse(rows: LegacyAssetRow[]): LegacyAsset[] {
  const out = new Map<string, LegacyAsset>();
  // เหลือไว้เพื่อความชัดเจนของเงื่อนไขข้างล่าง — ตอนนี้ acquisitionDate ที่ไม่ null
  // แปลว่ามาจากใบกำกับเสมอ (ไม่มีของสำรองให้ปนอีกแล้ว)
  const hasInvoice = new Set<string>();

  for (const r of rows) {
    const key = toStr(r.assetNumber);
    if (!key) continue;

    const invoiceDate = toDateOnly(r.acqDate);
    const prev = out.get(key);

    if (!prev) {
      // ชุดที่มาจาก OITM เหมือนกันทุกแถวของสินทรัพย์ชิ้นเดียวกัน (ที่ต่างคือฝั่งใบกำกับ)
      // หยิบจากแถวแรกพอ ไม่ต้องรวมแบบราคาหรือเทียบแบบวันที่
      const { categoryCode, departmentCode } = parseAssetClass(r.assetClass);
      out.set(key, {
        assetNumber: key,
        description: toStr(r.description),
        assetClass: toStr(r.assetClass),
        categoryCode,
        departmentCode,
        uom: toStr(r.uom),
        serialNumber: toStr(r.serialNumber),
        sapLocationId: toRef(r.locationCode),
        employeeCode: toRef(r.employeeCode),
        status: r.isActive?.trim().toUpperCase() === 'Y' ? 'Active' : 'Inactive',
        acquisitionDate: invoiceDate,
        sapCreatedDate: toDateOnly(r.createDate),
        // ชุดบัญชีมาจาก LEFT JOIN ITM8/ITM7 จึงเหมือนกันทุกแถวของชิ้นนี้ หยิบจากแถวแรกพอ
        // (หลักเดียวกับ assetClass/uom ข้างบน) — ไม่มี PeriodCat = ยังไม่มียอดใน SAP
        accounting: r.fiscalYear === null ? null : pickAccounting(r),
      });
      if (invoiceDate) hasInvoice.add(key);
      continue;
    }

    if (!invoiceDate) continue; // แถวไม่มีใบกำกับซ้ำมา — ไม่มีอะไรให้รวมเพิ่ม

    // เก็บใบที่เก่าที่สุดไว้ (แถวแรกอาจยังไม่มีใบกำกับ = null จึงต้องเช็ค null ด้วย)
    if (!hasInvoice.has(key) || prev.acquisitionDate === null || invoiceDate < prev.acquisitionDate) {
      prev.acquisitionDate = invoiceDate;
    }
    hasInvoice.add(key);
  }

  return [...out.values()];
}

/**
 * ช่องปรับปรุงที่ ams_db ไม่มีที่เก็บ — วัดแล้วเป็น 0 ทั้ง 25,816 แถว (2026-08-19)
 *
 * ถ้าวันไหนไม่เป็น 0 แปลว่าบัญชีตัดด้อยค่า/ตีราคาใหม่/คิดค่าเสื่อมพิเศษ แล้วยอดสะสมที่เราเก็บ
 * จะ**ต่ำกว่าความจริง** — ห้ามข้ามเงียบ ต้องดังพอให้มีคนมาดู
 */
const ADJUSTMENT_FIELDS = [
  'unplannedDep',
  'specialDep1',
  'specialDep2',
  'specialDep3',
  'writeUp',
  'appreciation',
] as const satisfies readonly (keyof AccountingSnapshot)[];

const hasUnsupportedAdjustment = (a: AccountingSnapshot): boolean =>
  ADJUSTMENT_FIELDS.some((f) => a[f] != null && toNum(a[f]) !== 0);

/**
 * มูลค่าทุนทางบัญชีที่ใช้จริง — APC ก่อน ถ้ายังเป็น 0 ค่อยถอยไปใช้ยอดรวมรายการซื้อ
 *
 * `ITM8.APC` คือ **ยอดยกมาต้นปีบัญชี** ไม่ใช่ยอดปลายปี ปีที่ซื้อจึงเป็น 0 เสมอเพราะตอน
 * ต้นปีของยังไม่เข้ามา ตัวรายการซื้อจริงอยู่ที่ ACQ1 แล้วมูลค่าถึงไปโผล่ใน ITM8 ปีถัดไป
 * (ยืนยันกับ COM-100-05-002: ปี 2005 APC=0 / ปี 2006 เป็นต้นไป APC=12,871.03 = ACQ1 เป๊ะ)
 *
 * ผลคือของที่เพิ่งซื้อในปีบัญชีปัจจุบันมีแถว ITM8 แถวเดียวคือแถวปีที่ซื้อ ซึ่ง APC = 0
 * — วัด 2026-08-24: 101 จาก 2,726 ชิ้นเป็นแบบนี้ และ 100 ชิ้นมียอดจริงใน ACQ1
 * ถ้าไม่ถอยไปเอา ของใหม่ทุกชิ้นจะเข้าระบบด้วยมูลค่า 0 โดยรอบ sync ยังขึ้น SUCCESS
 *
 * ★ ถอยเฉพาะตอน APC เป็น 0/NULL เท่านั้น **ห้ามให้ ACQ1 ทับเมื่อ APC มีค่าแล้ว** —
 * ACQ1 เป็นยอดรวม "รายการซื้อทั้งหมดที่เคยเกิด" ส่วน APC เป็นยอดคงเหลือที่ผ่านการ
 * ตัดจำหน่าย/ปรับปรุงมาแล้ว ทับเมื่อไหร่ = ฟื้นมูลค่าของที่ตัดจำหน่ายไปแล้วกลับมา
 * (ชุดที่วัดได้ไม่มีเคสตัดจำหน่ายปนมาเลย แต่กติกานี้กันไว้ล่วงหน้า)
 *
 * ACQ1 ไม่มีอะไรให้ = คืนค่าเดิมของ ITM8 ตามตรง (0 หรือ null) ไม่แต่งให้ดูดีกว่าความจริง
 * — มี 1 ชิ้นที่ไม่มียอดทั้งสองฝั่ง ซึ่งแปลว่าไม่เคยมีรายการซื้อจริง
 */
function resolveBookedCost(r: LegacyAssetRow): number | null {
  if (r.bookedCost != null && toNum(r.bookedCost) !== 0) return r.bookedCost;
  return r.acquisitionPostedTotal ?? r.bookedCost;
}

/** คัดเฉพาะช่องบัญชีออกจากแถวดิบ — ตัวแยก "ทะเบียนของ" กับ "ตัวเลขบัญชี" ออกจากกัน */
const pickAccounting = (r: LegacyAssetRow): AccountingSnapshot => ({
  fiscalYear: r.fiscalYear,
  bookedCost: resolveBookedCost(r),
  bookedCostHistorical: r.bookedCostHistorical,
  accumulatedDepreciation: r.accumulatedDepreciation,
  salvageValue: r.salvageValue,
  unplannedDep: r.unplannedDep,
  specialDep1: r.specialDep1,
  specialDep2: r.specialDep2,
  specialDep3: r.specialDep3,
  writeUp: r.writeUp,
  appreciation: r.appreciation,
  usefulLifeMonths: r.usefulLifeMonths,
  remainingLifeMonths: r.remainingLifeMonths,
  depreciationMethod: r.depreciationMethod,
  depreciationStart: r.depreciationStart,
  depreciationEnd: r.depreciationEnd,
});

/**
 * เขียนมูลค่าทางบัญชีปีล่าสุดลง asset_accounting — 1 แถวต่อสินทรัพย์ 1 ชิ้น
 *
 * ── ทับทั้งแถว ไม่ COALESCE ต่างจากทางเขียน asset ข้างบน
 *
 * ตารางนี้ไม่มีมนุษย์คนไหนเขียนเลย SAP เป็นเจ้าของทุกช่อง 100% ค่า NULL ที่มาจาก SAP
 * (เช่น ITM7 ไม่มีแถวคู่ → พารามิเตอร์ค่าเสื่อมว่าง) จึงเป็นความจริงที่ต้องสะท้อนตามตรง
 * ไม่ใช่ "อย่าไปล้างของเดิม" เหมือนตาราง asset ที่คนกรอกทับได้
 *
 * ── ของที่ SAP มีแต่ AMS ไม่มีชิ้นนั้น = ข้าม ไม่ใช่ error
 *
 * ปกติจะไม่เกิด เพราะ connector เดียวกันเพิ่งสร้างสินทรัพย์ครบทุกชิ้นไปก่อนหน้าในรอบเดียวกัน
 * ที่เหลือคือของที่ผู้ใช้ soft delete ทิ้งไปแล้ว — เคารพการลบ ไม่ปลุกกลับมาทางประตูหลัง
 *
 * ── ไม่ลบแถวที่ SAP เลิกส่งมา
 *
 * ต่างจาก sap_asset_unknown_number ที่เป็น "รายการปัญหา ณ รอบล่าสุด" — ตารางนี้คือ**ข้อมูล**
 * ของหายจาก SAP ไม่ได้แปลว่ามูลค่าที่เคยรู้เป็นโมฆะ ความเก่าดูได้จาก syncedAt/fiscalYear
 */
async function applyAccounting(
  tx: Tx,
  items: LegacyAsset[],
  companyCode: string,
): Promise<void> {
  const withAccounting = items.filter(
    (i): i is LegacyAsset & { accounting: AccountingSnapshot } => i.accounting !== null,
  );

  // ── ด่านกัน "ล้มเงียบ": ดึงสินทรัพย์มาได้ แต่ไม่มีข้อมูลบัญชีติดมาเลยสักชิ้น
  //
  // ฝั่งบัญชีเข้ามาทาง LEFT JOIN จึงพังแบบไม่มี error ได้ — ITM8 ถูกล้าง / ปีบัญชีใหม่
  // ยังไม่ถูก post / คิวรีกรองของทิ้งโดยไม่ตั้งใจ → ทุกแถวได้ fiscalYear = null
  // (เกิดจริงแล้วกับ MIG: โค้ดเคยฝัง DprArea = '01 Posting' ไว้ แต่ฐานนั้นตั้งชื่อสมุดว่า
  //  'Main Book' — ด่านนี้คือสิ่งเดียวที่ฟ้อง เพราะรอบ sync ขึ้น SUCCESS ตามปกติ)
  // แล้วรอบ sync จะขึ้น SUCCESS สวยงามทั้งที่มูลค่าไม่ได้อัปเดตเลย ต่างจากกรณีคิวรีพัง
  // (สิทธิ์/คอลัมน์หาย/timeout) ที่อย่างน้อยยังล้มดังให้เห็น
  //
  // สภาพปกติคือ 2,721 จาก 2,721 ชิ้นมียอด (วัด 2026-08-20) — ตกมาเหลือศูนย์ทั้งที่ยังมี
  // สินทรัพย์อยู่ ไม่ใช่เรื่องที่เกิดเองได้ตามธรรมชาติ
  //
  // ไม่ throw เพราะทะเบียนสินทรัพย์ที่เพิ่งเขียนไปข้างบนถูกต้องดีอยู่ ไม่มีเหตุให้ rollback
  // ทิ้ง — ของเก่าใน asset_accounting ก็ไม่ถูกแตะ มันจะค้างเก่าอยู่จนกว่าจะมีคนแก้ต้นทาง
  // ซึ่ง syncedAt เป็นตัวบอกอายุอยู่แล้ว
  if (withAccounting.length === 0) {
    if (items.length > 0) {
      console.error(
        `🛑 sync asset: ดึงสินทรัพย์มา ${items.length} ชิ้น แต่ไม่มีข้อมูลบัญชีติดมาเลยสักชิ้น — ` +
          `ปกติต้องมีเกือบทุกชิ้น ให้ไปตรวจว่า ITM8 ยังมีข้อมูลอยู่ไหม ด้วย ` +
          `SELECT DprArea, PeriodCat, count(*) FROM ITM8 GROUP BY DprArea, PeriodCat ` +
          `(ดู legacyAssetAll ที่ intrastucture/sap/queries.ts) — ` +
          `ค่าที่เก็บไว้เดิมไม่ถูกแตะ จะค้างเก่าไปจนกว่าจะแก้ต้นทาง`,
      );
    }
    return;
  }

  const anomalies = withAccounting.filter((i) => hasUnsupportedAdjustment(i.accounting));
  const anomalous = new Set(anomalies.map((i) => i.assetNumber));
  if (anomalies.length > 0) {
    console.error(
      `🛑 sync asset: พบรายการปรับปรุงที่ระบบยังไม่รองรับ ${anomalies.length} ชิ้น ` +
        `(ด้อยค่า/ตีราคาใหม่/ค่าเสื่อมพิเศษ) — ค่าเสื่อมสะสมของชิ้นเหล่านี้ถูกเก็บเป็น NULL ` +
        `แทนตัวเลขที่ต่ำกว่าความจริง ต้องเพิ่มคอลัมน์รองรับก่อนถึงจะใช้ตัวเลขได้: ` +
        anomalies.slice(0, OFF_SCHEME_LOG_SAMPLE).map((i) => i.assetNumber).join(', '),
    );
  }

  // items ผ่าน collapse มาแล้ว จึงไม่ซ้ำเลขอยู่แล้ว ไม่ต้อง dedupe ซ้ำ
  const idByNumber = new Map<string, number>();
  for (const part of chunk(withAccounting.map((i) => i.assetNumber), LOOKUP_CHUNK)) {
    // ★ ต้องกรอง companyCode — เลขสินทรัพย์ unique แค่ระดับ (companyCode, assetNumber)
    //   ไม่ใช่ทั้งตาราง (uq_asset_company_number) ถ้าไม่กรอง เลขที่ซ้ำข้ามบริษัทจะคืนมา
    //   หลายแถว แล้ว Map เก็บตัวสุดท้ายที่วนเจอ = ยอดบัญชีของบริษัทนี้ไปทับสินทรัพย์ของ
    //   อีกบริษัท ส่วนชิ้นที่ถูกต้องไม่ได้แถวเลย และไม่มีอะไรฟ้องสักทาง
    //
    //   เกิดจริงแล้ว (วัด 2026-09-02): 41 เลขซ้ำข้ามบริษัท — รอบ sync ของ UBP เขียนยอด
    //   ทับสินทรัพย์ UBA 41 ชิ้น (syncedAt ของแถวเหล่านั้นเป็นเวลารอบ UBP) ขณะที่ชิ้น UBP
    //   24 ชิ้นไม่มีข้อมูลบัญชีเลย ทั้งที่ ITM8 ใน SAP มีครบทุกตัว
    const found = await tx
      .select({ id: asset.id, assetNumber: asset.assetNumber })
      .from(asset)
      .where(
        and(
          eq(asset.companyCode, companyCode),
          inArray(asset.assetNumber, part),
          isNull(asset.deletedAt),
        ),
      );
    for (const r of found) if (r.assetNumber) idByNumber.set(r.assetNumber, r.id);
  }

  const values = withAccounting.flatMap((item) => {
    const number = item.assetNumber;
    const r = item.accounting;
    const assetId = idByNumber.get(number);
    if (assetId === undefined) return [];

    // fiscalYear เป็น NOT NULL — แถวที่บอกไม่ได้ว่าเป็นตัวเลขของปีไหน เก็บไปก็ตีความไม่ได้
    //
    // ★ ต้องเช็คด้วย regex ไม่ใช่ Number.isInteger: `Number(null)` และ `Number('')` คืน 0
    //   ซึ่งเป็นจำนวนเต็มที่ผ่านด่านสบาย ๆ แล้วจะได้แถวที่บอกว่า "ตัวเลขชุดนี้เป็นของปี ค.ศ. 0"
    //   (เจอตอนเขียนเทสต์ ไม่ใช่ตอนขึ้นจอบัญชี) SAP เก็บ PeriodCat เป็นสตริงปีสี่หลักเสมอ
    const yearText = toStr(r.fiscalYear);
    if (yearText === null || !/^\d{4}$/.test(yearText)) return [];
    const fiscalYear = Number(yearText);

    // ★ 0 คือค่าจริง (ของที่ยังไม่เริ่มคิดค่าเสื่อม) ห้ามแปลงเป็น NULL — วัดแล้วต่ำสุดคือ 0.000000
    const num = (v: number | null) => (v == null ? null : toNum(v));

    return [
      {
        assetId,
        fiscalYear,
        bookedCost: num(r.bookedCost),
        bookedCostHistorical: num(r.bookedCostHistorical),
        // ชิ้นที่มีรายการปรับปรุงที่เรายังไม่รองรับ → เก็บ NULL ("ยังไม่รู้") ดีกว่าเก็บเลขที่รู้ว่าผิด
        accumulatedDepreciation: anomalous.has(number) ? null : num(r.accumulatedDepreciation),
        salvageValue: num(r.salvageValue),
        usefulLifeMonths: r.usefulLifeMonths == null ? null : Math.trunc(toNum(r.usefulLifeMonths)),
        remainingLifeMonths:
          r.remainingLifeMonths == null ? null : Math.trunc(toNum(r.remainingLifeMonths)),
        depreciationMethod: toStr(r.depreciationMethod),
        depreciationStart: toDateOnly(r.depreciationStart),
        depreciationEnd: toDateOnly(r.depreciationEnd),
      },
    ];
  });

  for (const part of chunk(values, INSERT_CHUNK)) {
    await tx
      .insert(assetAccounting)
      .values(part)
      .onConflictDoUpdate({
        target: assetAccounting.assetId,
        set: {
          fiscalYear: sql`excluded."fiscalYear"`,
          bookedCost: sql`excluded."bookedCost"`,
          bookedCostHistorical: sql`excluded."bookedCostHistorical"`,
          accumulatedDepreciation: sql`excluded."accumulatedDepreciation"`,
          salvageValue: sql`excluded."salvageValue"`,
          usefulLifeMonths: sql`excluded."usefulLifeMonths"`,
          remainingLifeMonths: sql`excluded."remainingLifeMonths"`,
          depreciationMethod: sql`excluded."depreciationMethod"`,
          depreciationStart: sql`excluded."depreciationStart"`,
          depreciationEnd: sql`excluded."depreciationEnd"`,
          syncedAt: sql`now()`,
        },
      });
  }
}

const readState = (rows: (typeof sapAssetSync.$inferSelect)[], companyCode: string): SyncState =>
  requireRow(rows, `อ่าน sap_asset_sync (companyCode=${companyCode})`);

/** base ของ advisory lock สำหรับ entity นี้ — ผสมกับบริษัทด้วย lockKeyFor() */
const LOCK_BASE = 811003;

/** สร้าง connector ที่ผูกกับบริษัทหนึ่ง (0021) — ดูเหตุผลเต็มที่ makePoConnector */
export const makeAssetConnector = (
  companyCode: string,
  itemGroups: string | null,
): SyncConnector<LegacyAssetPull> => ({
  entity: `asset:${companyCode}`,
  lockKey: lockKeyFor(LOCK_BASE, companyCode),

  // ไม่มีอดีตให้ตามเก็บ — คืน null เพื่อให้ engine ปักพื้นที่ "ตอนนี้" แล้วเลิกโหมด backfill
  // ตั้งแต่รอบแรก (ทางเดียวกับที่ PO/GRPO ใช้ตอน SAP ไม่มีแถวเข้าเกณฑ์เลย)
  async fetchFloor() {
    return null;
  },

  // windows ไม่ถูกใช้โดยตั้งใจ — ดูเหตุผลข้อ 1 ที่หัวไฟล์ ดึงเต็มทุกรอบเสมอ
  //
  // สองคิวรีแทนหนึ่ง: ทะเบียนสินทรัพย์ (เยอะ มี join ใบกำกับ) กับรหัสจัดซื้อ (ไม่กี่สิบแถว
  // ไม่มี join) — เหตุผลที่ห้ามยุบรวมอยู่ที่ purchasingItemAll() ใน queries.ts
  async fetch() {
    const [assets, purchasing] = await Promise.all([
      // legacyAssetAll ไม่รับ itemGroups แล้ว — กรองด้วย ItemType = 'F' ซึ่งเป็นความหมาย
      // ไม่ใช่ผังกลุ่มของแต่ละบริษัท (ดู queries.ts) ส่วนรหัสจัดซื้อยังต้องใช้กลุ่มอยู่
      sapQuery<LegacyAssetRow>(companyCode, legacyAssetAll(), {}),
      sapQuery<PurchasingItemRow>(companyCode, purchasingItemAll(itemGroups), {}),
    ]);
    return { assets, purchasing };
  },

  async apply(tx, pull) {
    const { assets: rows, purchasing } = pull;
    // ★ ออกตั้งแต่ตรงนี้เมื่อ SAP ไม่คืนทะเบียนสินทรัพย์มาเลย — ไม่ใช่แค่ "ไม่มีอะไรให้เขียน"
    //   แต่เป็นการกันรายงานช่องว่างข้างล่างไม่ให้สรุปผิดว่า "SAP ไม่รู้จักเลขทุกตัวในระบบ"
    //   จากรอบที่คิวรีคืนว่างเพราะเหตุอื่น (ปกติต้องได้ ~2,300 แถวทุกรอบ)
    if (rows.length === 0) return emptyResult();

    // watermark คิดจากแถวดิบทั้งหมด ไม่ใช่แค่ที่เขียนสำเร็จ — ตัวเลขนี้ตอบแค่ว่า
    // "ข้อมูลที่เห็นสดถึงเมื่อไหร่" ไม่ได้เอาไปตัดหน้าต่างรอบหน้า
    const maxUpdateDate = maxIso(rows.map((r) => toIso(r.updateDate)));

    const items = collapse(rows);
    if (items.length === 0) return { ...emptyResult(), maxUpdateDate };

    // ── ของที่เลขไม่เข้าสคีมาบริษัท: ดึงเข้าเป็นสินทรัพย์ตามปกติ แต่ต้องรู้ว่ามีอยู่กี่ตัว
    //
    // ★ ติดธง ไม่ใช่คัดออก — ทุกแถวข้างล่างนี้ถูกเขียนลงตารางเหมือนกันหมด ไม่มีการข้าม
    //   (ของจริงที่เจอ: MAC-300-13-001.1/.2/.3 ชิ้นส่วนย่อยของ Day Tank, MAC-212-13-001/1
    //    ถัง Silo, MAC-1-21/12-002 เครื่องบรรจุ และ 'Vortex Ring Blower ยี่ห้อ Hitachi...'
    //    ที่มีคนกรอกชื่อสินค้าลงช่อง ItemCode)
    //
    // log รหัสออกมาได้ ต่างจากสาย PO ที่ log แค่ตัวเลข — เลขสินทรัพย์เป็นแค่ป้ายระบุตัว
    // ไม่มีราคา/ผู้ขาย/ข้อมูลจัดซื้อติดมาด้วย และการรู้ว่า "ตัวไหน" คือประโยชน์ทั้งหมดของบรรทัดนี้
    //
    // ถังตกค้างไม่ต้องมีตารางแยก เพราะของอยู่ใน asset แล้ว — คิวรีอยู่ที่ @common/asset-number
    const offScheme = items.filter((i) => !isAssetNumber(i.assetNumber));
    if (offScheme.length > 0) {
      const shown = offScheme.slice(0, OFF_SCHEME_LOG_SAMPLE).map((i) => i.assetNumber).join(', ');
      const more = offScheme.length - OFF_SCHEME_LOG_SAMPLE;
      console.warn(
        `⚠️  sync asset: เลขไม่เข้าสคีมา ${offScheme.length} ชิ้น (ดึงเข้าระบบตามปกติแล้ว) — ` +
          shown +
          (more > 0 ? ` …และอีก ${more}` : ''),
      );
    }

    const [location] = await tx
      .select({ id: assetLocation.id })
      .from(assetLocation)
      .where(eq(assetLocation.name, UNASSIGNED_LOCATION));
    if (!location) {
      // ล้มทั้งรอบดีกว่าเดาเอาห้องแรกที่เจอ — ของ 2,325 ชิ้นจะไปกองอยู่ในห้องของแผนกใด
      // แผนกหนึ่งโดยไม่มีใครรู้ แล้วรายงาน "สินทรัพย์ในความดูแล" ของแผนกนั้นพังทันที
      throw new Error(
        `ไม่พบที่ตั้ง '${UNASSIGNED_LOCATION}' ในตาราง asset_location — migration 0010 เป็นคนสร้างให้ ` +
          `ถ้าถูกลบไปแล้วต้องเพิ่มกลับก่อน sync สินทรัพย์เก่า`,
      );
    }

    // ── ตาราง master ที่ต้องใช้แปลงรหัสของ SAP เป็น id ของ AMS (เพิ่มใน 0011)
    //
    // ดึงมาทั้งตารางครั้งเดียวต่อรอบ ไม่ query ต่อชิ้น: ทั้งสี่ตารางมีหลักสิบถึงหลักร้อยแถว
    // ส่วนสินทรัพย์มี 2,325 ชิ้น — query ต่อชิ้นคือ 9,300 รอบในทรานแซกชันเดียว ซึ่งขัดกับ
    // หลักของ engine ที่ว่าทรานแซกชันต้องสั้น (ดู txMs ที่ sync.engine.ts)
    const categoryByCode = new Map(
      (await tx.select({ id: category.id, code: category.code }).from(category)).map((r) => [
        r.code,
        r.id,
      ]),
    );
    // ★★ ต้องกรอง companyCode (0026) — รหัสแผนกเป็นผังของแต่ละบริษัท ไม่ใช่เลขที่ไม่ซ้ำ
    //    ทั้งเครือ: '110' มีอยู่ทั้ง UBA/UBP/MIG คนละแผนกกัน (MIG ชน UBA 32 จาก 33 รหัส)
    //
    //    ถ้าไม่กรอง Map จะเก็บตัวสุดท้ายที่ select คืนมาชนะเงียบ ๆ แล้วสินทรัพย์ของบริษัทนี้
    //    จะถูกผูกเข้าแผนกของอีกบริษัท — ซึ่งตั้งแต่ 0026 fk_asset_department เป็นคีย์คู่
    //    (departmentId, companyCode) จะปฏิเสธ insert แล้ว **sync ล้มทั้งรอบ** ไม่ใช่แค่
    //    ข้อมูลเพี้ยน (บั๊กคลาสเดียวกับที่ import/employee.ts เจอตอน 0024)
    const departmentByCode = new Map(
      (await tx
        .select({ id: department.id, code: department.departmentId })
        .from(department)
        .where(eq(department.companyCode, companyCode)))
        .filter((r): r is { id: number; code: string } => r.code !== null)
        .map((r) => [r.code, r.id]),
    );
    // ผูกด้วย sapLocationId ไม่ใช่ id — id ของสองระบบบังเอิญตรงกันวันนี้เท่านั้น (ดู master.ts)
    //
    // ⚠️ ตารางนี้ยังไม่มี companyCode จึงกรองตามบริษัทไม่ได้ — OLCT ของแต่ละฐานเดินเลข
    //    อิสระกัน เลขเดียวกันจึงหมายถึงคนละที่ได้ และ uq_asset_location_sap_id เป็น unique
    //    ระดับทั้งระบบ = เก็บได้แถวเดียวต่อเลข ผลคือของบริษัทที่ import ทีหลังจะถูกวางที่
    //    สถานที่ของบริษัทแรกแบบเงียบ ๆ (ไม่มี FK จับให้เหมือนแผนก)
    //    ตอนนี้ยังไม่ระเบิดเพราะมีแต่ที่ตั้งของ UBA และ MIG/UBP ยังไม่ได้ import ที่ตั้ง
    //    — ต้องเติม companyCode ให้ asset_location ก่อนวันที่จะ import ที่ตั้งของบริษัทอื่น
    const locationBySapId = new Map(
      (await tx
        .select({ id: assetLocation.id, sapId: assetLocation.sapLocationId })
        .from(assetLocation))
        .filter((r): r is { id: number; sapId: number } => r.sapId !== null)
        .map((r) => [r.sapId, r.id]),
    );
    // ★ เฉพาะของบริษัทนี้ (0021) — OHEM แต่ละฐานเลขทับกัน 264 ตัว ค้นข้ามบริษัทคือผูกผิดคน
    //   ต่างจากฝั่ง PO ตรงที่นี่ต้องได้ "ทั้งบริษัท" ไม่ใช่เฉพาะรหัสที่พบในรอบนี้
    //   (resolve() ถูกเรียกทีละชิ้นจากชุดที่ดึงมา จึงต้องมี Map ครบก่อน)
    const employeeByOwnerCode = new Map(
      (await tx
        .select({ id: employeeCompany.employeeId, ownerCode: employeeCompany.ownerCode })
        .from(employeeCompany)
        .where(eq(employeeCompany.companyCode, companyCode)))
        .filter((r): r is { id: number; ownerCode: number } => r.ownerCode !== null)
        .map((r) => [r.ownerCode, r.id]),
    );

    // รหัสที่หาไม่เจอ = ปล่อยเป็น NULL ไม่ใช่โยน error และไม่ใช่สร้าง master ให้เอง
    // (master ที่ job สร้างเองจะโผล่ใน dropdown ทันทีทั้งที่ไม่มีใครตั้งใจ แล้วชนกับที่คนเพิ่มทีหลัง)
    // NULL ตรงนี้ตอบได้ว่า "ยังจับคู่ไม่ได้" และ query หาได้ว่าเหลือกี่ชิ้น
    const resolve = (i: LegacyAsset): ResolvedAsset => ({
      ...i,
      categoryId: (i.categoryCode && categoryByCode.get(i.categoryCode)) || null,
      departmentId: (i.departmentCode && departmentByCode.get(i.departmentCode)) || null,
      locationId: (i.sapLocationId && locationBySapId.get(i.sapLocationId)) || null,
      employeeId: (i.employeeCode && employeeByOwnerCode.get(i.employeeCode)) || null,
    });

    // ── สำรวจก่อนเขียน: เลขไหนมีเจ้าของอยู่แล้ว และเจ้าของนั้นมาทางไหน
    //
    // uq_asset_number เป็น partial index (WHERE deletedAt IS NULL) ซึ่งแปลว่าแถวที่ถูก
    // soft delete ไปแล้ว "ไม่ชน" — ถ้าไม่ดักตรงนี้ ของที่ผู้ใช้ตั้งใจลบทิ้งจะถูกสร้าง
    // กลับมาใหม่ทุกรอบ sync ตลอดไป และไม่มีทางลบให้อยู่
    const numbers = items.map((i) => i.assetNumber);
    const activeOrigin = new Map<string, 'PO_FLOW' | 'SAP_LEGACY'>();
    const seenAtAll = new Set<string>();
    for (const part of chunk(numbers, LOOKUP_CHUNK)) {
      const found = await tx
        .select({ assetNumber: asset.assetNumber, origin: asset.origin, deletedAt: asset.deletedAt })
        .from(asset)
        // ★ ต้อง scope ด้วยบริษัท (0021) — เลขสินทรัพย์ชนกันข้ามบริษัท 24 ตัว
        //   ไม่ scope แล้วจะเห็นแถวของอีกบริษัทแล้วสรุปผิดว่า "เลขนี้มีเจ้าของแล้ว"
        //   ผลคือของ UBP ถูกข้ามทิ้งเงียบ ๆ 24 ชิ้น
        .where(and(eq(asset.companyCode, companyCode), inArray(asset.assetNumber, part)));
      for (const r of found) {
        if (!r.assetNumber) continue;
        seenAtAll.add(r.assetNumber);
        if (r.deletedAt === null) activeOrigin.set(r.assetNumber, r.origin);
      }
    }

    const writable: ResolvedAsset[] = [];
    // ลงทะเบียนผ่าน AMS แล้ว — SAP ไม่ใช่เจ้าของแถว แต่เป็นเจ้าของสามคอลัมน์ (ดูหัวไฟล์)
    const enrichable: ResolvedAsset[] = [];
    let skipped = 0;
    let created = 0;
    for (const item of items) {
      const origin = activeOrigin.get(item.assetNumber);
      if (origin === 'PO_FLOW') { enrichable.push(resolve(item)); continue; }
      // เคยมีแต่ถูกลบไปแล้วและไม่มีตัวที่ยัง active — เคารพการลบ ไม่ปลุกขึ้นมาใหม่
      if (origin === undefined && seenAtAll.has(item.assetNumber)) { skipped++; continue; }
      if (origin === undefined) created++;
      writable.push(resolve(item));
    }

    // ── แยกทางเขียนสองสาย: ของใหม่ INSERT / ของเดิม UPDATE
    //
    // ทำไมไม่ยิง INSERT ... ON CONFLICT DO UPDATE ทั้งก้อนเหมือนเดิม: postgres คำนวณค่า
    // default ของทุกแถวที่เสนอเข้าไป "ก่อน" จะตรวจว่าชนหรือไม่ แปลว่า id ถูกดึงจาก
    // asset_id_seq ครบทุกแถวทุกรอบ sync ต่อให้สุดท้ายลง UPDATE ทั้งหมด และ sequence
    // ไม่คืนเลขที่ดึงไปแล้ว (by design — จะได้ไม่ต้องล็อกกันระหว่าง transaction)
    //
    // ของ 2,325 ชิ้นที่ sync ทุกนาที = 3.3 ล้านเลข/วัน ชนเพดาน int4 (2.1 พันล้าน) ใน ~2 ปี
    // ตอนเจอครั้งแรก asset_id_seq อยู่ที่ 9,314 ทั้งที่ทั้งตารางมีของจริง 2,335 แถว
    //
    // การสำรวจข้างบนบอกอยู่แล้วว่าเลขไหนมีแถวที่ยัง active — ใช้ผลนั้นแยกสายเลย
    // ไม่ต้องให้ pg ไปค้นพบทีหลัง
    const toInsert = writable.filter((i) => activeOrigin.get(i.assetNumber) === undefined);
    const toUpdate = writable.filter((i) => activeOrigin.get(i.assetNumber) !== undefined);

    // ── ตัวนับ "แถวที่เขียนจริง" — ตั้งแต่มี guard จำนวนที่ส่งเข้าไปกับที่เขียนได้ไม่เท่ากันแล้ว
    //    (ส่ง 2,700 แถวแต่เขียนจริง 3 แถวเป็นเรื่องปกติเมื่อ SAP ไม่ได้แก้อะไร)
    //    สายที่ 1 ไม่ต้องนับจากผลลัพธ์ — ของใหม่ทุกแถวถูกเขียนแน่นอนโดยนิยาม
    let updatedLegacy = 0;
    let updatedPoFlow = 0;

    for (const part of chunk(toInsert, INSERT_CHUNK)) {
      await tx
        .insert(asset)
        .values(
          part.map((i) => ({
            origin: 'SAP_LEGACY' as const,
            companyCode,
            assetNumber: i.assetNumber,
            description: i.description,
            assetClass: i.assetClass,
            status: i.status,
            // อยู่ในทะเบียนของ SAP แล้ว = ลงทะเบียนเสร็จแล้วโดยนิยาม ไม่ใช่ร่าง
            lifecycle: 'REGISTERED' as const,
            acquisitionDate: i.acquisitionDate,
            sapCreatedDate: i.sapCreatedDate,
            categoryId: i.categoryId,
            departmentId: i.departmentId,
            employeeId: i.employeeId,
            uom: i.uom,
            serialNumber: i.serialNumber,
            // QR ไม่ได้มาจาก SAP — AMS ประกอบเองจากเลขสินทรัพย์ (ดู assetQrUrl)
            // ของเก่าที่ sync เข้ามาต้องติดสติกเกอร์เหมือนของที่ลงทะเบียนผ่าน AMS ทุกประการ
            // ถ้าไม่เติมให้ตรงนี้ 2,700+ ชิ้นจะไม่มี QR ให้พิมพ์เลยสักใบ
            qrCode: assetQrUrl(companyCode, i.assetNumber),
            // SAP ไม่ได้ระบุที่ตั้ง (54 ชิ้น) หรือจับคู่ OLCT ไม่ได้ → ลงแถวพัก
            // locationId เป็น NOT NULL จึงต้องมีค่าเสมอ (ดูหมายเหตุ UNASSIGNED_LOCATION)
            locationId: i.locationId ?? location.id,
            // createdBy/updatedBy ปล่อย NULL — ไม่มีมนุษย์เป็นคนสร้างแถวนี้ (ดู asset.ts)
          })),
        )
        // เหลือไว้เป็นตาข่าย ไม่ใช่ทางหลักอีกต่อไป: ระหว่างที่เราสำรวจกับตอนเขียน อาจมี
        // รอบ sync อื่นหรือคนกดสร้างแทรกเลขเดียวกันเข้ามา — สายนี้มีแต่ของใหม่ จำนวนเลข
        // ที่ถูกดึงจาก sequence จึงเท่ากับจำนวนสินทรัพย์ใหม่จริง ซึ่งเป็นสิ่งที่ควรกินอยู่แล้ว
        .onConflictDoUpdate({
          // ★ ต้องเป็นสองคอลัมน์ให้ตรงกับ uq_asset_number หลัง 0021 — ระบุแค่ assetNumber
          //   pg จะหา index ที่ใช้แก้ conflict ไม่เจอ (และถ้าเจอ index เก่าค้างอยู่ จะทับ
          //   สินทรัพย์ของอีกบริษัทที่เลขตรงกัน ซึ่งวัดแล้วมี 24 ตัว)
          target: [asset.companyCode, asset.assetNumber],
          // ต้องระบุให้ตรงกับ partial index uq_asset_number ไม่งั้น pg หา index ที่ใช้
          // แก้ conflict ไม่เจอแล้วโยน "no unique or exclusion constraint matching"
          targetWhere: isNull(asset.deletedAt),
          set: {
            // แตะเฉพาะคอลัมน์ที่ SAP เป็นเจ้าของ — คำอธิบาย/QR/รูป/ห้องย่อย/พิกัดหมุด
            // เป็นของที่คนกรอกเองหลังจากนี้ ทับเมื่อไหร่คืองานที่หายไปเงียบ ๆ ทุกรอบ sync
            acquisitionDate: sql`excluded."acquisitionDate"`,
            // ทับเสมอเหมือน acquisitionDate — OITM.CreateDate มีครบทุกแถวและไม่เคยเป็น
            // ค่าที่คนกรอก การ COALESCE จึงไม่มีอะไรให้ปกป้อง
            sapCreatedDate: sql`excluded."sapCreatedDate"`,
            // validFor ของ SAP ชนะเฉพาะบนแกน Active↔Inactive — ดู sapStatusRule
            status: sapStatusRule(sql`excluded."status"`, sql`${asset.status}`),

            // ── ชุดที่มาจาก OITM (0011) — SAP เป็นเจ้าของ แก้ที่ SAP แล้วไหลมาเองทุกรอบ
            //
            //    COALESCE ไม่ได้แปลว่า "ของเดิมชนะ" แต่แปลว่า "SAP ไม่มีค่า → อย่าไปล้างของเดิม"
            //    ค่าที่ SAP มีจะทับเสมอ ส่วน NULL จาก SAP คือ 'ไม่เคยกรอก' ไม่ใช่ 'สั่งให้ลบ'
            //    (uom ว่าง 3 แถว, serialNumber ว่าง 2,278 แถว — ถ้าทับตรง ๆ ของที่เคยเติมหายหมด)
            assetClass: sql`COALESCE(excluded."assetClass", ${asset.assetClass})`,
            categoryId: sql`COALESCE(excluded."categoryId", ${asset.categoryId})`,
            departmentId: sql`COALESCE(excluded."departmentId", ${asset.departmentId})`,
            employeeId: sql`COALESCE(excluded."employeeId", ${asset.employeeId})`,
            uom: sql`COALESCE(excluded."uom", ${asset.uom})`,
            serialNumber: sql`COALESCE(excluded."serialNumber", ${asset.serialNumber})`,

            // ★ QR ทับเสมอ ไม่ COALESCE — มันเป็นค่าที่ derive จาก APP_BASE_URL + เลขสินทรัพย์
            //   ล้วน ๆ ไม่มีมนุษย์คนไหนเขียน และไม่มีที่ไหนในระบบใช้มันเป็นคีย์ค้นหา
            //   (ใช้แค่ตอนวาด QR ไปพิมพ์ — grep qrCode ดูได้ มีแต่ที่เขียนกับที่วาด)
            //
            //   ถ้าเติมเฉพาะตอนว่าง ค่าที่ผิดจะถูกตรึงถาวร: ตอนนี้ APP_BASE_URL ยังเป็น
            //   localhost อยู่ ถ้าล็อกไว้ก่อน แก้โดเมนทีหลังแล้ว sync ใหม่ก็ไม่ช่วยอะไรเลย
            //   ต้องไปไล่ UPDATE ด้วยมือ 2,700 แถว — ทับเสมอทำให้แก้ config แล้วหายเอง
            //   (env.ts เขียนไว้ตรง ๆ อยู่แล้วว่าเปลี่ยนโดเมน = ต้องไล่พิมพ์สติกเกอร์ใหม่)
            qrCode: sql`excluded."qrCode"`,

            // ที่ตั้งใช้กติกาเดียวกับคอลัมน์อื่น (SAP ชนะ) แต่เขียน COALESCE ตรง ๆ ไม่ได้
            // เพราะ locationId เป็น NOT NULL — "SAP ไม่ได้ระบุ" เดินทางมาถึงตรงนี้ในรูปของ
            // แถวพัก 'ยังไม่ระบุที่ตั้ง' ไม่ใช่ NULL (ดู values ข้างบน) จึงต้องเทียบกับ id ของแถวนั้น
            //
            // เงื่อนไขดูที่ฝั่ง excluded ไม่ใช่ฝั่งแถวเดิม: ถามว่า "SAP มีค่าให้ไหม" ไม่ใช่
            // "ฝั่งเรายังว่างอยู่ไหม" — 54 ชิ้นที่ SAP ไม่ได้ระบุจึงไม่ถูกดีดกลับไปเป็น
            // 'ยังไม่ระบุที่ตั้ง' ทุกรอบ ทั้งที่อาจมีคนไปเติมที่ตั้งให้แล้ว
            locationId: sql`CASE WHEN excluded."locationId" = ${location.id}
                                 THEN ${asset.locationId}
                                 ELSE excluded."locationId" END`,
            updatedAt: sql`now()`,
          },
          // ตาข่ายชั้นสอง: กันแถว PO_FLOW ที่แทรกเข้ามาระหว่างที่เราสำรวจกับตอนเขียน
          // (การสำรวจข้างบนกันได้แค่สิ่งที่มีอยู่ ณ ตอนอ่าน)
          // ★ guard เดียวกับสายที่ 2 — สองที่นี้คือกฎเดียวกันเขียนคนละภาษา ต้องแก้คู่กันเสมอ
          //   (สายนี้เจอ conflict เฉพาะตอน race จึงแทบไม่ยิงจริง แต่ถ้าปล่อยให้ต่างกัน
          //    ผลของการ sync จะขึ้นกับว่าแถวนั้นมาทางไหน ซึ่งไล่หาทีหลังแทบไม่เจอ)
          setWhere: and(
            eq(asset.origin, 'SAP_LEGACY'),
            sapLegacyChanged(
              (c) => sql.raw(`"asset"."${c}"`),
              (c) => sql.raw(`excluded."${c}"`),
              location.id,
            ),
          ),
        });
    }

    // ── ของเดิม: UPDATE ... FROM (VALUES ...) คำสั่งเดียวต่อ chunk เท่าเดิม แต่ไม่แตะ
    //    default ของ id จึงไม่กิน sequence เลย
    //
    // ชุดคอลัมน์และกติกา COALESCE/CASE ต้องตรงกับ set: ของ onConflictDoUpdate ข้างบนเป๊ะ
    // — สองที่นี้คือกฎเดียวกันที่เขียนคนละภาษา แก้ที่หนึ่งแล้วลืมอีกที่ = ของที่ sync มา
    // จะต่างกันขึ้นกับว่าแถวนั้นเป็นของใหม่หรือของเดิม ซึ่งไล่หาทีหลังแทบไม่เจอ
    //
    // ทุกค่าต้อง cast ชนิดกำกับใน VALUES: parameter ที่ส่งเข้ามาเป็น unknown ฝั่ง pg
    // ถ้าไม่บอกชนิด มันเดาจากบริบทไม่ได้แล้วโยน "could not determine data type"
    for (const part of chunk(toUpdate, INSERT_CHUNK)) {
      const rows = part.map(
        (i) => sql`(${i.assetNumber}::varchar, ${i.acquisitionDate}::date,
                    ${i.sapCreatedDate}::date, ${i.assetClass}::varchar,
                    ${i.categoryId}::integer, ${i.departmentId}::integer,
                    ${i.employeeId}::integer, ${i.uom}::varchar,
                    ${i.serialNumber}::varchar, ${i.locationId ?? location.id}::integer,
                    ${assetQrUrl(companyCode, i.assetNumber)}::varchar,
                    ${i.status}::asset_status)`,
      );

      const res = await tx.execute(sql`
        UPDATE ${asset} AS a SET
          "acquisitionDate" = v."acquisitionDate",
          "sapCreatedDate"  = v."sapCreatedDate",
          "assetClass"      = COALESCE(v."assetClass", a."assetClass"),
          "categoryId"      = COALESCE(v."categoryId", a."categoryId"),
          "departmentId"    = COALESCE(v."departmentId", a."departmentId"),
          "employeeId"      = COALESCE(v."employeeId", a."employeeId"),
          "uom"             = COALESCE(v."uom", a."uom"),
          "serialNumber"    = COALESCE(v."serialNumber", a."serialNumber"),
          -- QR ทับเสมอ ให้ตามค่า APP_BASE_URL ปัจจุบัน — เหตุผลเต็มอยู่ฝั่ง onConflictDoUpdate
          "qrCode"          = v."qrCode",
          "locationId"      = CASE WHEN v."locationId" = ${location.id}
                                   THEN a."locationId" ELSE v."locationId" END,
          -- validFor ของ SAP ชนะเฉพาะบนแกน Active↔Inactive — ดู sapStatusRule
          "status"          = ${sapStatusRule(sql`v."status"`, sql`a."status"`)},
          "updatedAt"       = now()
        FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(
          "assetNumber", "acquisitionDate", "sapCreatedDate", "assetClass", "categoryId",
          "departmentId", "employeeId", "uom", "serialNumber", "locationId", "qrCode",
          "status"
        )
        WHERE a."assetNumber" = v."assetNumber"
          -- ★ ต้องมีบริษัทด้วย ไม่งั้นรอบ sync ของ UBA จะไปแก้แถวของ UBP ที่เลขตรงกัน
          AND a."companyCode" = ${companyCode}
          AND a."deletedAt" IS NULL
          -- เงื่อนไขเดียวกับ setWhere ข้างบน: ของที่ลงทะเบียนผ่าน AMS แล้ว SAP ไม่ใช่เจ้าของ
          AND a.origin = 'SAP_LEGACY'
          -- ★ แตะเฉพาะแถวที่ค่าจะเปลี่ยนจริง — ดู sapLegacyChanged
          AND ${sapLegacyChanged(
            (c) => sql.raw(`a."${c}"`),
            (c) => sql.raw(`v."${c}"`),
            location.id,
          )}
      `);
      updatedLegacy += rowsAffected(res);
    }

    // ── สายที่สาม: แถว PO_FLOW เติมเฉพาะ assetClass / categoryId / uom / sapCreatedDate / status
    //
    // ★ สายนี้ **ไม่ใช่** ฝาแฝดของสองสายข้างบน อย่าไล่ให้ชุดคอลัมน์ตรงกัน — สองสายบนคือ
    //   "SAP เป็นเจ้าของทั้งแถว" ส่วนสายนี้คือ "SAP เป็นเจ้าของห้าช่อง" คนละกฎกันโดยตั้งใจ
    //
    // ★ status เข้าชุดนี้เพราะการตัดจำหน่ายในบัญชีไม่ได้แยกว่าของชิ้นนั้นเข้าระบบมาทางไหน
    //   ใช้ sapStatusRule ตัวเดียวกับสองสายบน (ทับเฉพาะแกน Active↔Inactive) จึงไม่ไปล้าง
    //   สถานะที่คนตั้งเอง — เป็นข้อยกเว้นเดียวของประโยค "อย่าไล่ให้ชุดคอลัมน์ตรงกัน"
    //
    // ★ sapCreatedDate เข้าชุดนี้ได้เพราะเป็นวันที่ SAP สร้างแถว OITM ล้วน ๆ ซึ่ง AMS
    //   ไม่มีทางรู้เองและไม่มีช่องให้ใครกรอกทับ — ต่างจาก departmentId/employeeId/
    //   locationId ที่บนแถว PO_FLOW มาจากใบคำขอ ซึ่ง AMS รู้ดีกว่า SAP (ห้ามเติมเข้าชุดนี้)
    //   (กฎที่ต้องตรงกันเป๊ะคือคู่ onConflictDoUpdate ↔ UPDATE...FROM VALUES ของ SAP_LEGACY)
    //
    // COALESCE เหมือนสายอื่น: SAP มีค่า → ทับ / SAP ว่าง → คงของเดิม (คนกรอกเองไว้ก็ไม่หาย)
    //
    // ⚠️ เงื่อนไข IS DISTINCT FROM ท้าย WHERE ไม่ใช่การจูนความเร็ว แต่กัน updatedAt ไม่ให้
    //    ขยับทุกนาทีที่ scheduler เดินทั้งที่ไม่มีอะไรเปลี่ยน — แถว PO_FLOW มี updatedBy
    //    เป็น "คนล่าสุดที่แก้" อยู่จริง ถ้า updatedAt วิ่งไปเรื่อยแต่ updatedBy ค้างที่เดิม
    //    หน้าจอจะเล่าเรื่องผิดว่าคนนั้นเพิ่งแก้เมื่อครู่ (แถว SAP_LEGACY ไม่มีปัญหานี้เพราะ
    //    updatedBy เป็น NULL — ไม่มีมนุษย์ให้กล่าวหา)
    for (const part of chunk(enrichable, INSERT_CHUNK)) {
      const rows = part.map(
        (i) => sql`(${i.assetNumber}::varchar, ${i.assetClass}::varchar,
                    ${i.categoryId}::integer, ${i.uom}::varchar,
                    ${i.sapCreatedDate}::date, ${i.status}::asset_status)`,
      );

      const res = await tx.execute(sql`
        UPDATE ${asset} AS a SET
          "assetClass" = COALESCE(v."assetClass", a."assetClass"),
          "categoryId" = COALESCE(v."categoryId", a."categoryId"),
          "uom"        = COALESCE(v."uom", a."uom"),
          "sapCreatedDate" = COALESCE(v."sapCreatedDate", a."sapCreatedDate"),
          "status"     = ${sapStatusRule(sql`v."status"`, sql`a."status"`)},
          "updatedAt"  = now()
        FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(
          "assetNumber", "assetClass", "categoryId", "uom", "sapCreatedDate", "status"
        )
        WHERE a."assetNumber" = v."assetNumber"
          -- ★ ต้องมีบริษัทด้วย ไม่งั้นรอบ sync ของ UBA จะไปแก้แถวของ UBP ที่เลขตรงกัน
          AND a."companyCode" = ${companyCode}
          AND a."deletedAt" IS NULL
          -- ตรงข้ามกับสองสายบน: สายนี้แตะเฉพาะแถวที่ AMS เป็นคนสร้าง
          AND a.origin = 'PO_FLOW'
          AND (
                a."assetClass" IS DISTINCT FROM COALESCE(v."assetClass", a."assetClass")
             OR a."categoryId" IS DISTINCT FROM COALESCE(v."categoryId", a."categoryId")
             OR a."uom"        IS DISTINCT FROM COALESCE(v."uom",        a."uom")
             OR a."sapCreatedDate" IS DISTINCT FROM COALESCE(v."sapCreatedDate", a."sapCreatedDate")
             -- ต้องเป็นนิพจน์เดียวกับฝั่ง SET เป๊ะ (เรียก sapStatusRule ตัวเดิม) ไม่ใช่เขียนย่อ
             -- เอง — เงื่อนไขที่ไม่ตรงกับค่าที่จะเขียนจริงคือแถวที่ควรอัปเดตแล้วไม่ถูกแตะ
             OR a."status" IS DISTINCT FROM ${sapStatusRule(sql`v."status"`, sql`a."status"`)}
          )
      `);
      updatedPoFlow += rowsAffected(res);
    }

    // ── สายที่สี่: ชิ้นที่ยังไม่มีเลขสินทรัพย์ — เติมจาก "รหัสจัดซื้อ" บนบรรทัด PO แทน
    //
    // ทางเข้าเดียวกับสายบนเป๊ะ (AMS ถือรหัส → ถาม OITM → เอาสามช่องกลับมา) ต่างกันแค่
    // คีย์ที่ใช้ถาม: สายบนใช้เลขสินทรัพย์ที่บัญชีพิมพ์ให้ สายนี้ใช้ purchase_order_item.itemCode
    // ที่ติดมากับบรรทัด PO ตั้งแต่ตอนซื้อ — ชิ้นที่ยังไม่ได้ออกเลขจึงไม่ต้องรอเป็น NULL ค้าง
    //
    // ★ ของหยาบกว่าเสมอ จึง "เติมเฉพาะช่องที่ยังว่าง" ไม่ใช่ทับ: รหัสจัดซื้อหนึ่งตัวคลุมของ
    //   หลายร้อยชิ้นที่ไม่เกี่ยวกัน ('1216401' = จอ + โต๊ะพับ + เก้าอี้ + UPS) ค่าที่ได้จึงจริง
    //   ระดับหมวดเท่านั้น พอชิ้นนั้นมีเลขสินทรัพย์จริงเมื่อไหร่ สายบนจะทับด้วยของที่ตรงกว่า
    //   สังเกต COALESCE กลับข้างกับสายอื่น: ที่นี่ของเดิมชนะ ที่อื่น SAP ชนะ
    //
    // ★ ห้ามให้สายนี้สร้างแถว asset ใหม่เด็ดขาด — รหัสจัดซื้อไม่ใช่ของสักชิ้น ถ้า upsert
    //   เหมือนเลขสินทรัพย์จะได้แถวปลอมที่แท้จริงคือรหัสบัญชี โผล่บน dashboard ทันที
    const purchasingRows = purchasing
      .map((p) => {
        const itemCode = toStr(p.itemCode);
        if (!itemCode) return null;
        const { categoryCode } = parseAssetClass(p.assetClass);
        return {
          itemCode,
          assetClass: toStr(p.assetClass),
          categoryId: (categoryCode && categoryByCode.get(categoryCode)) || null,
          uom: toStr(p.uom),
        };
      })
      // รหัสที่ไม่มีอะไรให้เติมสักช่อง ตัดทิ้งตั้งแต่ต้น ไม่ต้องส่งลง SQL ให้เปลือง
      .filter(
        (p): p is NonNullable<typeof p> =>
          p !== null && (p.assetClass !== null || p.categoryId !== null || p.uom !== null),
      );

    for (const part of chunk(purchasingRows, INSERT_CHUNK)) {
      const values = part.map(
        (p) => sql`(${p.itemCode}::varchar, ${p.assetClass}::varchar,
                    ${p.categoryId}::integer, ${p.uom}::varchar)`,
      );

      await tx.execute(sql`
        UPDATE ${asset} AS a SET
          "assetClass" = COALESCE(a."assetClass", v."assetClass"),
          "categoryId" = COALESCE(a."categoryId", v."categoryId"),
          "uom"        = COALESCE(a."uom",        v."uom"),
          "updatedAt"  = now()
        FROM (VALUES ${sql.join(values, sql`, `)}) AS v(
          "itemCode", "assetClass", "categoryId", "uom"
        ), ${purchaseOrderItem} AS pi
        WHERE pi."id" = a."poItemId"
          AND pi."itemCode" = v."itemCode"
          -- ★ ต้องมีบริษัทด้วยเหมือนสองสายบน — v มาจาก OITM ของบริษัทนี้บริษัทเดียว
          --   ส่วน purchase_order_item.itemCode เป็นรหัสดิบไม่มี prefix บริษัทติดมา
          --   (ต่างจาก poNumber) และรหัสจัดซื้อคือรหัสบัญชีที่ทั้งเครือใช้ผังเดียวกัน
          --   ไม่กรองแล้วรอบ sync ของ UBA จะเติมค่าจาก OITM ของ UBA ลงแถว PO_FLOW
          --   ของ UBP ที่ itemCode ตรงกัน — เบากว่าสายบนเพราะเติมเฉพาะช่องว่าง
          --   (COALESCE กลับข้าง ไม่ทับของเดิม) แต่ก็ยังเป็นค่าของผิดบริษัทแบบไม่มีอะไรฟ้อง
          AND a."companyCode" = ${companyCode}
          AND a.origin = 'PO_FLOW'
          AND a."deletedAt" IS NULL
          -- แตะเฉพาะแถวที่ได้อะไรเพิ่มจริง ๆ (เหตุผลเดียวกับ IS DISTINCT FROM ของสายบน)
          AND ( (a."assetClass" IS NULL AND v."assetClass" IS NOT NULL)
             OR (a."categoryId" IS NULL AND v."categoryId" IS NOT NULL)
             OR (a."uom"        IS NULL AND v."uom"        IS NOT NULL) )
      `);
    }

    // ── รายงานช่องว่าง: เลขที่ AMS ถืออยู่ แต่หาไม่เจอใน SAP
    //
    // ถามกลับด้านกับทุกสายข้างบน — ข้างบนเดินจากของที่ SAP มี ตรงนี้เดินจากของที่ AMS มี
    // แล้วดูว่าตัวไหนไม่มีคู่ ซึ่งเป็นอาการของปัญหาจริงเสมอ (พิมพ์เลขผิด หรือของชิ้นนั้น
    // ยังไม่ถูกลงทะเบียนใน SAP) และเดิมไม่มีอะไรบอกเลยสักทาง
    const sapNumbers = new Set(items.map((i) => i.assetNumber));
    // ★ กรอง companyCode ด้วย — sapNumbers เป็นเลขจาก SAP ของบริษัทนี้บริษัทเดียว
    //   ถ้าสำรวจข้ามบริษัท ของบริษัทอื่นจะถูกตัดสินว่า "SAP ไม่รู้จัก" ทุกชิ้น ทั้งที่แค่
    //   ไปถามผิดฐาน แล้วรายงานจะพลิกไปมาตามว่าบริษัทไหน sync ทีหลัง
    const numbered = await tx
      .select({ id: asset.id, assetNumber: asset.assetNumber, poNumber: purchaseOrderItem.poNumber })
      .from(asset)
      .leftJoin(purchaseOrderItem, eq(purchaseOrderItem.id, asset.poItemId))
      .where(
        and(
          eq(asset.companyCode, companyCode),
          eq(asset.origin, 'PO_FLOW'),
          isNotNull(asset.assetNumber),
          isNull(asset.deletedAt),
        ),
      );

    const unknown = numbered.filter((r) => !sapNumbers.has(r.assetNumber!));

    // ── ล้างทุกแถวที่ "ไม่ใช่ของที่ยังหาไม่เจอ ณ รอบนี้" แล้วค่อย upsert ชุดปัจจุบันทับ
    //
    // ★ เคยเขียนเป็น "ลบเฉพาะตัวที่หาเจอแล้ว" ซึ่งผิด: แถวที่หลุดออกจากชุดสำรวจไปเลย
    //   จะไม่ถูกแตะทั้งสองทาง แล้วค้างในรายงานตลอดกาล เกิดได้สามทางที่เป็นเรื่องปกติทั้งหมด
    //   — สินทรัพย์ถูก soft delete / เลขถูกแก้เป็นค่าอื่น / เลขถูกล้างเป็น NULL
    //   (จะเจอทันทีตอนลบข้อมูลทดสอบทิ้ง: ของหายไปแล้วแต่รายงานยังฟ้องอยู่)
    //
    // นิยามที่ถูกคือ "ตารางนี้ = ชุดของที่หาไม่เจอ ณ รอบล่าสุด" ลบส่วนเกินทิ้งจึงตรงกว่า
    // และไม่ต้องไล่แจกแจงว่าหลุดออกไปด้วยเหตุใด — ตารางเล็กมาก (หลักสิบ) สแกนทั้งตารางไม่แพง
    // ★ ขอบเขตการล้างต้องเป็น "บริษัทนี้" ไม่ใช่ทั้งตาราง — ตารางไม่มีคอลัมน์ companyCode
    //   จึงต้องวงไว้ผ่าน asset ไม่งั้นรอบ sync ของบริษัทหนึ่งจะลบรายงานของบริษัทอื่นทิ้ง
    //   ทุกครั้ง (คู่กับตัวกรองข้างบน — แก้ทีละจุดไม่พอ ต้องแก้พร้อมกัน)
    const unknownIds = unknown.map((r) => r.id);
    const ownScope = inArray(
      sapAssetUnknownNumber.assetId,
      tx.select({ id: asset.id }).from(asset).where(eq(asset.companyCode, companyCode)),
    );
    await tx
      .delete(sapAssetUnknownNumber)
      .where(
        unknownIds.length > 0
          ? and(ownScope, notInArray(sapAssetUnknownNumber.assetId, unknownIds))
          : ownScope,
      );

    for (const part of chunk(unknown, INSERT_CHUNK)) {
      await tx
        .insert(sapAssetUnknownNumber)
        .values(
          part.map((r) => ({
            assetId: r.id,
            assetNumber: r.assetNumber!,
            poNumber: r.poNumber,
          })),
        )
        .onConflictDoUpdate({
          target: sapAssetUnknownNumber.assetId,
          // firstSeenAt ไม่อยู่ใน set โดยตั้งใจ — ต้องคงค่าเดิมไว้ ไม่งั้นทุกรอบจะรีเซ็ตเป็น
          // วันนี้ แล้วคำถาม "เรื่องนี้ค้างมานานแค่ไหน" จะตอบไม่ได้ (หลักเดียวกับ sap_grpo_unlinked)
          set: {
            assetNumber: sql`excluded."assetNumber"`,
            poNumber: sql`excluded."poNumber"`,
            lastSeenAt: sql`now()`,
          },
        });
    }

    // ── มูลค่าทางบัญชี — ต้องเป็นขั้นตอน "สุดท้าย" ของรอบ
    //
    // asset_accounting.assetId เป็น FK ไปที่ asset แถวสินทรัพย์ที่เพิ่งถูกสร้างข้างบนจึงต้อง
    // มีอยู่แล้วก่อนถึงบรรทัดนี้ (อยู่ในทรานแซกชันเดียวกัน มองเห็นกันได้) ถ้าย้ายขึ้นไปข้างบน
    // ของใหม่ทุกชิ้นจะเขียนมูลค่าไม่ได้ในรอบแรกที่มันเข้าระบบ
    await applyAccounting(tx, items, companyCode);

    return {
      // ★ นับ "แถวที่เขียนจริง" ไม่ใช่ "แถวที่ส่งไปให้พิจารณา" — ตั้งแต่ใส่ guard สองค่านี้
      //   ต่างกันมาก (ส่ง 2,700 เขียนจริง 3) ถ้ายังนับแบบเดิม ตัวเลขบนหน้าจอจะบอกว่า
      //   sync แตะ 2,700 แถวทุกรอบตลอดไป ซึ่งเป็นภาพที่ตรงข้ามกับความจริงหลังแก้
      //
      //   toInsert ไม่ต้องอ่านจากผลลัพธ์ — ของใหม่ทุกแถวถูกเขียนแน่นอนโดยนิยาม
      //   (onConflictDoUpdate ที่ห้อยอยู่เป็นตาข่ายกัน race เท่านั้น)
      rowsHeader: toInsert.length + updatedLegacy + updatedPoFlow,
      rowsLine: created,
      // เหลือความหมายเดียว: แถวที่ไม่ได้แตะเลย (เลขนั้นถูก soft delete ไปแล้ว)
      // เดิมตัวเลขนี้รวมแถว PO_FLOW ที่ข้ามทั้งแถวไว้ด้วย ซึ่งไม่มีอีกแล้ว
      rowsSkipped: skipped,
      maxUpdateDate,
    };
  },

  async readState(tx) {
    const rows = await tx.select().from(sapAssetSync).where(eq(sapAssetSync.companyCode, companyCode));
    return readState(rows, companyCode);
  },

  async readStateOutsideTx() {
    const rows = await db.select().from(sapAssetSync).where(eq(sapAssetSync.companyCode, companyCode));
    if (rows.length === 0) {
      const created = await db.insert(sapAssetSync).values({ companyCode }).returning();
      return readState(created, companyCode);
    }
    return readState(rows, companyCode);
  },

  async writeState(tx, patch) {
    const now = nowIso();
    await tx
      .update(sapAssetSync)
      .set({ ...patch, lastRunAt: now, updatedAt: now })
      .where(eq(sapAssetSync.companyCode, companyCode));
  },

  async openEvent(tx, row) {
    const created = requireRow(
      await tx
        .insert(sapAssetSyncEvent)
        .values({ ...row, companyCode, status: 'RUNNING' })
        .returning({ id: sapAssetSyncEvent.id }),
      'open sap_asset_sync_event',
    );
    return created.id;
  },

  async closeEvent(tx, id, row) {
    await tx
      .update(sapAssetSyncEvent)
      .set({ ...row, finishedAt: nowIso() })
      .where(eq(sapAssetSyncEvent.id, id));
  },

  async logFailure(row) {
    const now = nowIso();
    await db.insert(sapAssetSyncEvent).values({
      companyCode,
      trigger: row.trigger,
      triggeredBy: row.triggeredBy,
      mode: row.mode,
      status: 'FAILED',
      error: row.error,
      sapMs: row.sapMs,
      finishedAt: now,
    });
    await db
      .update(sapAssetSync)
      .set({ lastStatus: 'FAILED', lastError: row.error, lastRunAt: now, updatedAt: now })
      .where(eq(sapAssetSync.companyCode, companyCode));
  },
});
