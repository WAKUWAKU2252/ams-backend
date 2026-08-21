// ═══════════════════════════════════════════════════════════════════════════
// T-SQL ที่ยิงไป SAP — รวมไว้ที่เดียวเพื่อให้เห็นทั้งหมดว่าเราแตะตารางอะไรบ้าง
// (ทุกคำสั่งเป็น SELECT ล้วน — ถ้ามีอย่างอื่นโผล่มาในไฟล์นี้แปลว่าผิดแล้ว)
//
// ตัวกรองสินทรัพย์อยู่ระดับ "บรรทัด" ไม่ใช่ระดับใบ: OPOR/OPDN ทั้งระบบมีหลักหมื่นใบ
// แต่ที่เกี่ยวกับ AMS คือบรรทัดที่ item อยู่ในกลุ่มตาม SAP_ITEM_GROUPS เท่านั้น
// (ปัจจุบัน 117 = fixed asset อย่างเดียว — ดูเหตุผลที่ถอด 114 ออกใน config/env.ts)
// กรองที่ต้นทางทำให้ดึงมาน้อย เบาต่อ SAP และ ams_db ไม่บวมด้วยของที่ไม่ใช้
//
// หน้าต่างเวลาใช้ >= from และ < to (ครึ่งเปิด) เพื่อให้หน้าต่างที่ต่อกันไม่ทับซ้อน
// และไม่มีรูตรงรอยต่อ ส่วน from/to เป็น NULL ได้ = ไม่จำกัดด้านนั้น
//
// ทำไมต่อรายการกลุ่มสินค้าลง SQL ตรง ๆ แทน STRING_SPLIT: ฟังก์ชันนั้นต้องการ
// SQL Server 2016+ ที่ compatibility level >= 130 ซึ่ง SAP B1 หลายที่ตั้งต่ำกว่านั้น
// แล้วจะพังด้วย "Invalid object name 'STRING_SPLIT'" — ปลอดภัยกว่าถ้าเราคุมค่าเอง
// (ค่ามาจาก env ที่ schema บังคับ ^\d+(,\d+)*$ แล้ว และตรวจซ้ำใน itemGroupList())
// ═══════════════════════════════════════════════════════════════════════════
import { env } from '@config/env';
import { purchasingCodeSqlFilter } from '@common/asset-number';

/** แปลง env เป็นรายการตัวเลขที่ปลอดภัยพอจะต่อลง SQL — ไม่ผ่านการตรวจ = ไม่ยอมยิง */
export function itemGroupList(): string {
  const groups = env.SAP_ITEM_GROUPS.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);
  if (groups.length === 0) throw new Error('SAP_ITEM_GROUPS ไม่มีเลขกลุ่มสินค้าที่ใช้ได้');
  return groups.join(',');
}

/** เลขเอกสารที่รับมาจากผลลัพธ์ SAP เอง — ตรวจซ้ำก่อนต่อลง SQL ตามหลักเดียวกัน */
function docEntryList(docEntries: number[]): string {
  const list = docEntries.filter((n) => Number.isInteger(n) && n >= 0);
  if (list.length === 0) throw new Error('docEntries ว่างหรือไม่ใช่จำนวนเต็ม');
  return list.join(',');
}

// PO — หนึ่งแถวต่อ "บรรทัด PO" (header ซ้ำตามจำนวนบรรทัด แล้วไปยุบฝั่ง connector)
export const poWindow = () => `
SELECT
    po.DocEntry     AS docEntry,
    po.DocNum       AS docNum,
    po.CardName     AS vendorName,
    po.DocDate      AS docDate,
    po.OwnerCode    AS ownerCode,
    -- 'O' = Open / 'C' = Closed — connector แปลงเป็น OPEN/CLOSED ก่อนเขียนลง ams_db
    -- ส่งตัวอักษรดิบมาไม่แปลงที่นี่ เพื่อให้ SQL ยังเป็นภาพตรง ๆ ของ SAP
    po.DocStatus    AS docStatus,
    po.UpdateDate   AS updateDate,
    LTRIM(RTRIM(ISNULL(e.firstName, '') + ' ' + ISNULL(e.lastName, ''))) AS ownerPrName,
    p1.LineNum      AS lineNum,
    p1.ItemCode     AS itemCode,
    i.ItmsGrpCod    AS itemGroup,
    p1.Dscription   AS itemDescription,
    p1.Quantity     AS quantity,
    p1.Price        AS unitPrice,
    p1.LineTotal    AS lineTotal
FROM OPOR po
JOIN POR1 p1 ON p1.DocEntry = po.DocEntry
JOIN OITM i  ON i.ItemCode  = p1.ItemCode
LEFT JOIN OHEM e ON e.empID = po.OwnerCode
WHERE i.ItmsGrpCod IN (${itemGroupList()})
  AND (@from IS NULL OR po.UpdateDate >= @from)
  AND (@to   IS NULL OR po.UpdateDate <  @to)
ORDER BY po.UpdateDate, po.DocEntry, p1.LineNum;`;

// PO ใบเดียวตาม DocEntry — ใช้ตอน sync GRPO แล้วเจอว่า PO แม่ยังไม่ถูกดึง
// (ระหว่าง backfill ถอยหลัง GRPO เดือนนี้อ้าง PO ที่อาจอยู่ย้อนไปหลายเดือน
//  ถ้ารอให้ backfill เดินไปถึงเอง grpo_line จะ insert ไม่ได้เพราะ FK)
export const poByDocEntries = (docEntries: number[]) => `
SELECT
    po.DocEntry     AS docEntry,
    po.DocNum       AS docNum,
    po.CardName     AS vendorName,
    po.DocDate      AS docDate,
    po.OwnerCode    AS ownerCode,
    -- 'O' = Open / 'C' = Closed — connector แปลงเป็น OPEN/CLOSED ก่อนเขียนลง ams_db
    -- ส่งตัวอักษรดิบมาไม่แปลงที่นี่ เพื่อให้ SQL ยังเป็นภาพตรง ๆ ของ SAP
    po.DocStatus    AS docStatus,
    po.UpdateDate   AS updateDate,
    LTRIM(RTRIM(ISNULL(e.firstName, '') + ' ' + ISNULL(e.lastName, ''))) AS ownerPrName,
    p1.LineNum      AS lineNum,
    p1.ItemCode     AS itemCode,
    i.ItmsGrpCod    AS itemGroup,
    p1.Dscription   AS itemDescription,
    p1.Quantity     AS quantity,
    p1.Price        AS unitPrice,
    p1.LineTotal    AS lineTotal
FROM OPOR po
JOIN POR1 p1 ON p1.DocEntry = po.DocEntry
JOIN OITM i  ON i.ItemCode  = p1.ItemCode
LEFT JOIN OHEM e ON e.empID = po.OwnerCode
WHERE po.DocEntry IN (${docEntryList(docEntries)})
  AND i.ItmsGrpCod IN (${itemGroupList()})
ORDER BY po.DocEntry, p1.LineNum;`;

// GRPO — BaseType 22 = บรรทัดนี้ copy มาจาก PO; baseEntry/baseLine ชี้กลับบรรทัด PO ต้นทาง
// (LineNum ของ SAP เป็น 0-based และเราเก็บตามนั้น ห้ามขยับเป็น 1-based ไม่งั้น join พัง)
//
// join OPOR กลับไปเอา DocNum ด้วย เพราะ BaseEntry เป็น DocEntry (PK ภายในของ SAP)
// แต่ฝั่ง AMS เก็บ poNumber = DocNum (เลขที่คนเห็น) — สองอันนี้คนละเลข ถ้าไม่แปลงตรงนี้
// ต้องไปเก็บ DocEntry เพิ่มอีกคอลัมน์ใน ams_db ซึ่งไม่มีใครใช้นอกจาก sync
//
// ── ทำไม BaseType อยู่ใน SELECT ไม่ใช่ WHERE และทำไม OPOR เป็น LEFT JOIN
// เงื่อนไขใน WHERE ตอบได้แค่ "เอา/ไม่เอา" แถวที่ไม่ผ่านหายไปก่อนถึงโค้ดเรา ไม่เหลือ
// ร่องรอยว่าเคยมี — GRPO ที่รับของโดยไม่ผ่าน PO (ของแถม/ของตัวอย่าง/รับตรง) จึงหายเงียบ
// ทั้งที่ item เป็นกลุ่มสินทรัพย์เหมือนกันและอาจต้องติดป้าย/ตัดค่าเสื่อมจริง
// ย้ายมาเป็นคอลัมน์แล้วให้ connector ตัดสินเอง จะได้เลือกได้ว่าเขียนลงตารางหลัก
// หรือลง sap_grpo_unlinked พร้อมเหตุผล
//
// สองอย่างนี้ต้องแก้คู่กัน: ถ้าเอา BaseType ออกจาก WHERE แต่ยังคง JOIN OPOR เป็น inner
// แถว BaseType=-1 (BaseEntry เป็น -1) ก็ยัง match OPOR ไม่ได้อยู่ดี ผลลัพธ์เท่าเดิมเป๊ะ
//
// ตัวกรอง ItmsGrpCod ยังอยู่ครบ — ของที่เพิ่มเข้ามาจึงจำกัดอยู่แค่บรรทัดกลุ่มสินทรัพย์
// ที่ไม่มี PO ไม่ใช่ GRPO ทั้งบริษัท
export const grpoWindow = () => `
SELECT
    gr.DocEntry     AS docEntry,
    gr.DocNum       AS docNum,
    gr.DocDate      AS docDate,
    gr.UpdateDate   AS updateDate,
    d1.LineNum      AS lineNum,
    d1.ItemCode     AS itemCode,
    d1.Dscription   AS itemDescription,
    d1.Quantity     AS receivedQty,
    d1.BaseType     AS baseType,
    d1.BaseEntry    AS baseEntry,
    d1.BaseLine     AS baseLine,
    po.DocNum       AS basePoNumber
FROM OPDN gr
JOIN PDN1 d1 ON d1.DocEntry = gr.DocEntry
JOIN OITM i  ON i.ItemCode  = d1.ItemCode
LEFT JOIN OPOR po ON po.DocEntry = d1.BaseEntry
WHERE i.ItmsGrpCod IN (${itemGroupList()})
  AND (@from IS NULL OR gr.UpdateDate >= @from)
  AND (@to   IS NULL OR gr.UpdateDate <  @to)
ORDER BY gr.UpdateDate, gr.DocEntry, d1.LineNum;`;

// จุดต่ำสุดของประวัติ — ถามครั้งเดียวตอนรอบแรกเพื่อรู้ว่า backfill ต้องถอยถึงไหนแล้วจบ
// (ไม่รู้ค่านี้ = ไม่รู้ว่าเมื่อไหร่ควรเลิกถอย แล้วจะถอยไปเรื่อย ๆ ในอดีตที่ไม่มีข้อมูล)
export const poMinUpdateDate = () => `
SELECT MIN(po.UpdateDate) AS minUpdateDate
FROM OPOR po
JOIN POR1 p1 ON p1.DocEntry = po.DocEntry
JOIN OITM i  ON i.ItemCode  = p1.ItemCode
WHERE i.ItmsGrpCod IN (${itemGroupList()});`;

// ═══════════════════════════════════════════════════════════════════════════
// สินทรัพย์เก่าที่มีอยู่ใน SAP ก่อน AMS — คนละเส้นทางกับ PO/GRPO โดยสิ้นเชิง
//
// Finance ลงทะเบียนสินทรัพย์ด้วยการคีย์ A/P invoice แบบไม่อ้างเอกสารต้นทาง (BaseType -1)
// ตัวสินทรัพย์เองเป็น "item" ใน OITM — คนละชุดกับรหัสจัดซื้อที่เป็นตัวเลขล้วนบน PO
// (เช่น 5320107) ทั้งสองชุดอยู่ในกลุ่ม 117 เหมือนกัน จึงต้องแยกออกจากกันที่นี่
//
// ★ ตัวกรองมีชั้นเดียว: "ไม่ใช่ตัวเลขล้วน" — ไม่ได้กรองด้วยรูปแบบเลขสินทรัพย์
//
// เคยกรองด้วยรูปแบบ แล้ว**สินทรัพย์จริง 396 ชิ้นไม่เคยเข้าระบบเลย** เพราะรูปแบบที่เขียนไว้
// แคบกว่าความจริง (ท่อนท้ายมีทั้ง B101 / 001BP / 001.1 / 001/1) และการไล่ขยายให้ครอบก็พลาด
// ซ้ำอีกสองรอบ — ของที่ตกกติกาใน WHERE จะหายเงียบเสมอ ไม่มีอะไรฟ้อง
//
// ตอนนี้จึงดึงมาให้หมดแล้วให้ connector ตัดสินด้วย regex ฝั่ง TypeScript ซึ่งอ่านออกและ
// นับของที่ไม่เข้าสคีมาออกมาให้เห็นได้ (ดู isAssetNumber ใน @common/asset-number)
//
// ที่ยังต้องกรองตัวเลขล้วนออกตั้งแต่ SQL เพราะ LEFT JOIN PCH1 ข้างล่าง: รหัสจัดซื้อหนึ่งตัว
// อยู่บนใบกำกับหลักพันถึงหลักหมื่นใบ ปล่อยเข้ามาผลจะบานทันที (และรหัสบัญชีก็ไม่ใช่ของสักชิ้น
// อยู่ดี — มันไปอยู่ใน purchasingItemAll ข้างล่างแทน)
//
// ไม่มีหน้าต่างเวลา และไม่มีพารามิเตอร์ — ดึงเต็มทุกรอบ (~2,300 แถว) เพราะนี่คือ
// item master ไม่ใช่กองเอกสารที่โตตามเวลา สถานะปัจจุบันคือสิ่งเดียวที่มีความหมาย
//
// LEFT JOIN ใบกำกับ: ประมาณครึ่งหนึ่งไม่มีใบเลย (ของเก่ามาก/ยกยอดมา) ถ้าใช้ inner join
// สินทรัพย์กลุ่มนั้นจะหายไปทั้งที่มีตัวตนจริงและต้องติดป้าย QR เหมือนกัน — ปล่อยให้
// acqDate/acqCost เป็น NULL แล้วให้ connector ถอยไปใช้ OITM.CreateDate แทนวันที่
//
// หนึ่งสินทรัพย์อาจอยู่บนหลายใบ (ของเหมา/งานโครงการ 1 รหัส = หลายการซื้อ ~10 ตัว)
// จึงคืนมาหลายแถวได้ต่อหนึ่ง assetNumber — connector เป็นคนยุบ (ดู asset.connector.ts)
// ── คอลัมน์ชุดสินทรัพย์ (เพิ่มใน 0011 หลังสำรวจ OITM จริง)
// AssetClass  = '<รหัสบัญชี>-<0 สำนักงาน/1 โรงงาน>-<รหัส cost center>' เช่น '1216401-0-775'
//               มีครบทั้ง 2,325 แถว — ท่อน 1 ไปเป็นหมวด ท่อน 3 ไปเป็นแผนก (ดู asset.connector.ts)
// Location    = int ชี้ OLCT ซึ่ง asset_location ฝั่งเรา import มาจากตารางเดียวกัน (2,271 แถวมีค่า)
// Employee    = int (OHEM.empID) ผู้ถือครองที่ Finance ระบุไว้ — 161 แถว
// AssetSerNo  = serial จริง แต่กรอกไว้แค่ 47 แถว (ที่เหลือ NULL)
// InvntryUom  = หน่วยนับ 13 ค่า ว่าง 3 แถว
//
// ⚠️ ห้ามกลับไปแกะความหมายจาก ItemCode: 3 ตัวอักษรหน้า (FUR/COM/MAC) ไม่ใช่หมวด และท่อน
// ที่สองเป็นรหัส cost center ชุดเก่าที่ยุบไปแล้ว — 1,095 จาก 2,325 หาใน OOCR ไม่เจอ
// ── มูลค่าทางบัญชีมาในคิวรีเดียวกัน แล้วให้ connector แยกลงสองตาราง
//
// แพทเทิร์นเดียวกับ poWindow ที่คืนแถวละบรรทัด PO แล้วแยกเป็น purchase_order +
// purchase_order_item — ขอบเขต "กลุ่ม 117 + ไม่ใช่ตัวเลขล้วน" จึงมีที่เดียว ไม่ใช่สองที่
// ให้ drift (เคยแยกเป็นคิวรีที่สอง แล้วกฎขอบเขตซ้ำกันสองแห่งทันที — ถอยกลับมารวม)
//
// ★ join แล้วแถวไม่บาน: latest ถูกกรอง rn = 1 เหลือ 1 แถวต่อ ItemCode ส่วน ITM7 ก็ grain
//   เดียวกัน จำนวนแถวจึงเท่าเดิมเป๊ะ (เท่ากับจำนวนใบกำกับต่อสินทรัพย์) แค่กว้างขึ้น —
//   ค่าบัญชีจะซ้ำทุกแถวของสินทรัพย์เดียวกัน เหมือน assetClass/uom ที่ซ้ำอยู่แล้ว
//   collapse() หยิบจากแถวแรกเหมือนกันหมด
//
// ★ ต้องเป็น LEFT JOIN: สินทรัพย์ที่ยังไม่มียอดบัญชีต้องยังเข้าทะเบียนได้ตามปกติ
//   ถ้าใช้ inner join มันจะหายทั้งชิ้นเพราะขาดข้อมูลรอง ซึ่งกลับหัวกลับหางกับความสำคัญ
//
// ★ DprArea = '01 Posting' — ทั้งฐานมีชุดเดียว ถ้าวันหลังมีหลาย area grain จะเปลี่ยน
//   แล้วต้องกลับมาคิดใหม่ทั้งหมด (latest จะไม่ใช่ 1 แถวต่อ ItemCode อีกต่อไป → แถวบาน)
//
// UnDpAcc / SpDpAcc1-3 / WriteUpAcc / AppreAcc ดึงมาแต่ไม่มีที่เก็บ — ใช้ตรวจว่ายังเป็น 0
// อยู่ทุกรอบ วันที่บัญชีตัดด้อยค่า/ตีราคาใหม่ ยอดสะสมที่เราเก็บจะต่ำกว่าจริงทันที
export const legacyAssetAll = () => `
WITH latest AS (
    SELECT b.ItemCode, b.PeriodCat, b.APC, b.APCHist, b.OrDpAcc, b.SalvageVal,
           b.UnDpAcc, b.SpDpAcc1, b.SpDpAcc2, b.SpDpAcc3, b.WriteUpAcc, b.AppreAcc,
           ROW_NUMBER() OVER (PARTITION BY b.ItemCode ORDER BY b.PeriodCat DESC) AS rn
    FROM ITM8 b
    WHERE b.DprArea = '01 Posting'
)
SELECT
    i.ItemCode      AS assetNumber,
    i.ItemName      AS description,
    i.validFor      AS isActive,
    i.CreateDate    AS createDate,
    i.UpdateDate    AS updateDate,
    i.AssetClass    AS assetClass,
    i.InvntryUom    AS uom,
    i.AssetSerNo    AS serialNumber,
    i.Location      AS locationCode,
    i.Employee      AS employeeCode,
    ph.DocDate      AS acqDate,
    ph.CardName     AS vendor,
    ph.DocNum       AS invoiceNo,
    p1.LineTotal    AS acqCost,
    l.PeriodCat     AS fiscalYear,
    l.APC           AS bookedCost,
    l.APCHist       AS bookedCostHistorical,
    l.OrDpAcc       AS accumulatedDepreciation,
    l.SalvageVal    AS salvageValue,
    l.UnDpAcc       AS unplannedDep,
    l.SpDpAcc1      AS specialDep1,
    l.SpDpAcc2      AS specialDep2,
    l.SpDpAcc3      AS specialDep3,
    l.WriteUpAcc    AS writeUp,
    l.AppreAcc      AS appreciation,
    dp.UsefulLife   AS usefulLifeMonths,
    dp.RemainLife   AS remainingLifeMonths,
    dp.DprType      AS depreciationMethod,
    dp.DprStart     AS depreciationStart,
    dp.DprEnd       AS depreciationEnd
FROM OITM i
LEFT JOIN PCH1 p1 ON p1.ItemCode = i.ItemCode
LEFT JOIN OPCH ph ON ph.DocEntry = p1.DocEntry
LEFT JOIN latest l  ON l.ItemCode = i.ItemCode AND l.rn = 1
LEFT JOIN ITM7 dp   ON dp.ItemCode = i.ItemCode
                   AND dp.DprArea = '01 Posting'
                   AND dp.PeriodCat = l.PeriodCat
WHERE i.ItmsGrpCod IN (${itemGroupList()})
  AND NOT (${purchasingCodeSqlFilter('i.ItemCode')})
ORDER BY i.ItemCode, ph.DocDate;`;

// ── รหัสจัดซื้อในกลุ่มเดียวกัน = ตัวเลขล้วน (มีอยู่ 5 ตัว วัด 2026-08-20)
//
// กลุ่ม 117 มีของสองชุดปนกัน: เลขสินทรัพย์ (คิวรีข้างบน) กับรหัสจัดซื้อที่เป็นตัวเลขล้วน
// เช่น '1216401' ซึ่งเป็นรหัสบัญชี/หมวด ไม่ใช่ของชิ้นใดชิ้นหนึ่ง — PO/GRPO ใช้ชุดหลัง
//
// ⚠️ นิยาม "รหัสจัดซื้อ" ต้องเป็น **ตัวเลขล้วน** ห้ามกลับไปเป็น "ไม่ใช่รูปแบบเลขสินทรัพย์"
// นิยามแบบหลังเคยเหมารวมสินทรัพย์จริง 396 ชิ้นมาเป็นรหัสจัดซื้อ รวมถึงอาคารโรงงาน APC 27 ล้าน
//
// ★ ทำไมต้องแยกคิวรี ไม่ใช่รวมกับอันบน — สองเหตุผล ห้ามยุบรวมกลับ:
//   1) ผลของคิวรีบนไหลเข้าทาง upsert ที่ "ไม่เจอ = สร้างสินทรัพย์ใหม่" รหัสจัดซื้อจะกลาย
//      เป็นแถว asset ปลอมที่จริง ๆ เป็นรหัสบัญชี โผล่ใน dashboard ทันทีและลบยาก
//   2) อันบน LEFT JOIN PCH1/OPCH เพื่อหาใบกำกับ — รหัสจัดซื้อหนึ่งตัวอยู่บนใบกำกับ
//      หลักพันถึงหลักหมื่นใบ (1 รหัส = ของหลายร้อยชิ้นหลายปี) join แล้วผลบาน
//      และไม่มีประโยชน์ด้วย เพราะ "ราคาของรหัสบัญชี" ไม่ใช่ราคาของชิ้นไหนเลย
//      (วัดแล้ว: กลุ่ม 117 มี 2,726 ชิ้น มีข้อมูลบัญชี 2,721 — ที่ขาด 5 คือรหัสตัวเลขล้วนพอดี
//       แปลว่ารหัสจัดซื้อไม่มีมูลค่าทางบัญชีของตัวเองอยู่แล้ว)
//
// จึงเอามาแค่สามช่องที่เป็นความจริงระดับหมวด: AssetClass / InvntryUom (+ ItemName ไว้ให้คน
// อ่านตอนไล่ปัญหา) ใช้เติมชิ้นที่ยังไม่มีเลขสินทรัพย์เท่านั้น — ดู asset.connector.ts
export const purchasingItemAll = () => `
SELECT
    i.ItemCode      AS itemCode,
    i.ItemName      AS description,
    i.AssetClass    AS assetClass,
    i.InvntryUom    AS uom
FROM OITM i
WHERE i.ItmsGrpCod IN (${itemGroupList()})
  AND ${purchasingCodeSqlFilter('i.ItemCode')}
ORDER BY i.ItemCode;`;

// ไม่มี BaseType ที่นี่โดยตั้งใจ — ขอบเขตต้องตรงกับ grpoWindow เป๊ะ ถ้ากรองแคบกว่าจะได้
// MIN ที่ใหม่เกินจริง แล้ว backfill จะหยุดถอยก่อนเวลา ทำให้ GRPO แบบไม่มี PO ที่เก่ากว่านั้น
// ไม่มีวันถูกเก็บ และไม่มีอะไรบอกด้วยว่าหยุดเร็วไป
export const grpoMinUpdateDate = () => `
SELECT MIN(gr.UpdateDate) AS minUpdateDate
FROM OPDN gr
JOIN PDN1 d1 ON d1.DocEntry = gr.DocEntry
JOIN OITM i  ON i.ItemCode  = d1.ItemCode
WHERE i.ItmsGrpCod IN (${itemGroupList()});`;
