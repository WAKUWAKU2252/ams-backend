// ═══════════════════════════════════════════════════════════════════════════
// T-SQL ที่ยิงไป SAP — รวมไว้ที่เดียวเพื่อให้เห็นทั้งหมดว่าเราแตะตารางอะไรบ้าง
// (ทุกคำสั่งเป็น SELECT ล้วน — ถ้ามีอย่างอื่นโผล่มาในไฟล์นี้แปลว่าผิดแล้ว)
//
// ตัวกรองสินทรัพย์อยู่ระดับ "บรรทัด" ไม่ใช่ระดับใบ: OPOR/OPDN ทั้งระบบมีหลักหมื่นใบ
// แต่ที่เกี่ยวกับ AMS คือบรรทัดที่ item อยู่ในกลุ่มตาม company.itemGroups ของบริษัทนั้น
// (UBA = 117 · UBP = 110 — คนละผัง ห้ามรวมเป็นลิสต์เดียว ดู itemGroupList())
// กรองที่ต้นทางทำให้ดึงมาน้อย เบาต่อ SAP และ ams_db ไม่บวมด้วยของที่ไม่ใช้
//
// หน้าต่างเวลาใช้ >= from และ < to (ครึ่งเปิด) เพื่อให้หน้าต่างที่ต่อกันไม่ทับซ้อน
// และไม่มีรูตรงรอยต่อ ส่วน from/to เป็น NULL ได้ = ไม่จำกัดด้านนั้น
//
// ทำไมต่อรายการกลุ่มสินค้าลง SQL ตรง ๆ แทน STRING_SPLIT: ฟังก์ชันนั้นต้องการ
// SQL Server 2016+ ที่ compatibility level >= 130 ซึ่ง SAP B1 หลายที่ตั้งต่ำกว่านั้น
// แล้วจะพังด้วย "Invalid object name 'STRING_SPLIT'" — ปลอดภัยกว่าถ้าเราคุมค่าเอง
// (ค่ามาจาก company.itemGroups ซึ่ง itemGroupList() ตรวจว่าเป็นจำนวนเต็มก่อนต่อลง SQL)
// ═══════════════════════════════════════════════════════════════════════════
import { purchasingCodeSqlFilter } from '@common/asset-number';

// ── ★ ห้ามใส่ตัวกรอง `CANCELED <> 'Y'` ลงในคิวรีชุดนี้ (เคยใส่แล้วถอดออก 2026-09-04)
//
// เจตนาคือ "ไม่เอาใบที่ถูกยกเลิก" ซึ่งฟังดูถูก แต่ผลจริงกลับด้าน: ใบที่ sync เข้ามาตอน
// ยังไม่ยกเลิก แล้วค่อยถูกยกเลิกทีหลัง จะหลุดจากผลลัพธ์ทันที รอบถัดไปมองไม่เห็นมันอีกเลย
// → แถวใน ams_db ค้างที่สถานะ ณ วันที่ sync ครั้งสุดท้าย (ซึ่งอาจเป็น OPEN) **ตลอดไป**
// กลายเป็นใบที่ดูเหมือนยังใช้งานได้บนหน้าค้นหา ทั้งที่ถูกยกเลิกไปแล้ว
//
// ★ ไม่ต้องกรองก็ได้ผลที่ต้องการอยู่แล้ว: SAP ปิดใบให้เองตอนยกเลิก
//   วัด 2026-09-04 ทุกบริษัท — `CANCELED = 'Y' AND DocStatus = 'O'` คืนค่าว่างเสมอ
//   ใบยกเลิกจึงไหลกลับมาพร้อม DocStatus = 'C' แล้ว toDocStatus() แปลงเป็น CLOSED ให้เอง
//   แถวอัปเดตตามความจริงทุกรอบ ไม่มีอะไรค้าง และหน้าจอกรองด้วย docStatus ได้ตามปกติ
//
// ⚠️ ถ้าวันหลังเจอใบที่ CANCELED='Y' แต่ DocStatus='O' แปลว่าข้อสมมติข้างบนพังแล้ว
//    ตอนนั้นต้องเก็บ CANCELED เป็นคอลัมน์ของตัวเอง **ไม่ใช่กลับไปกรองทิ้ง**

/**
 * แปลงรายการกลุ่มสินค้าของบริษัทเป็นตัวเลขที่ปลอดภัยพอจะต่อลง SQL — ไม่ผ่านการตรวจ = ไม่ยอมยิง
 *
 * ค่ามาจาก company.itemGroups ไม่ใช่ env.SAP_ITEM_GROUPS อีกแล้ว (0021) เพราะเลขกลุ่มเป็น
 * ผังของแต่ละบริษัท ไม่ได้แปลว่าอะไรร่วมกัน: UBA ใช้ 117 · UBP ใช้ 110 · และ UBP ไม่มี
 * กลุ่ม 117 อยู่เลย ยิงรวมเป็นลิสต์เดียวข้ามฐานจึงได้ของผิดชุด
 *
 * ⚠️ ค่านี้ถูกต่อลง SQL ตรง ๆ — การตรวจว่าเป็นจำนวนเต็มคือกำแพงเดียวที่กัน injection
 *    ห้ามถอดออกไม่ว่าต้นทางจะดู "เชื่อถือได้" แค่ไหน (ตอนนี้มาจาก DB ไม่ใช่ env แล้ว)
 */
export function itemGroupList(itemGroups: string | null): string {
  const groups = (itemGroups ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0);
  if (groups.length === 0) throw new Error('company.itemGroups ไม่มีเลขกลุ่มสินค้าที่ใช้ได้');
  return groups.join(',');
}

/** เลขเอกสารที่รับมาจากผลลัพธ์ SAP เอง — ตรวจซ้ำก่อนต่อลง SQL ตามหลักเดียวกัน */
function docEntryList(docEntries: number[]): string {
  const list = docEntries.filter((n) => Number.isInteger(n) && n >= 0);
  if (list.length === 0) throw new Error('docEntries ว่างหรือไม่ใช่จำนวนเต็ม');
  return list.join(',');
}

// PO — หนึ่งแถวต่อ "บรรทัด PO" (header ซ้ำตามจำนวนบรรทัด แล้วไปยุบฝั่ง connector)
export const poWindow = (itemGroups: string | null) => `
SELECT
    po.DocEntry     AS docEntry,
    po.DocNum       AS docNum,
    -- prefix ของ numbering series (NNM1.BeginStr) เช่น 'APO-' / 'PPO-' (0021)
    -- connector ประกอบเป็นเลขเต็ม 'APO-62605007' ก่อนเขียนลง ams_db
    -- LEFT ไม่ใช่ inner: series 'Primary' ที่ BeginStr เป็น NULL ยังมีอยู่ในตาราง
    -- ถ้าใช้ inner ใบที่ใช้ series นั้นจะหายเงียบ
    s.BeginStr      AS beginStr,
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
LEFT JOIN OHEM e ON e.empID  = po.OwnerCode
LEFT JOIN NNM1 s ON s.Series = po.Series AND s.ObjectCode = '22'
WHERE i.ItmsGrpCod IN (${itemGroupList(itemGroups)})
  AND (@from IS NULL OR po.UpdateDate >= @from)
  AND (@to   IS NULL OR po.UpdateDate <  @to)
ORDER BY po.UpdateDate, po.DocEntry, p1.LineNum;`;

// PO ใบเดียวตาม DocEntry — ใช้ตอน sync GRPO แล้วเจอว่า PO แม่ยังไม่ถูกดึง
// (ระหว่าง backfill ถอยหลัง GRPO เดือนนี้อ้าง PO ที่อาจอยู่ย้อนไปหลายเดือน
//  ถ้ารอให้ backfill เดินไปถึงเอง grpo_line จะ insert ไม่ได้เพราะ FK)
export const poByDocEntries = (itemGroups: string | null, docEntries: number[]) => `
SELECT
    po.DocEntry     AS docEntry,
    po.DocNum       AS docNum,
    -- prefix ของ numbering series (NNM1.BeginStr) เช่น 'APO-' / 'PPO-' (0021)
    -- connector ประกอบเป็นเลขเต็ม 'APO-62605007' ก่อนเขียนลง ams_db
    -- LEFT ไม่ใช่ inner: series 'Primary' ที่ BeginStr เป็น NULL ยังมีอยู่ในตาราง
    -- ถ้าใช้ inner ใบที่ใช้ series นั้นจะหายเงียบ
    s.BeginStr      AS beginStr,
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
LEFT JOIN OHEM e ON e.empID  = po.OwnerCode
LEFT JOIN NNM1 s ON s.Series = po.Series AND s.ObjectCode = '22'
WHERE po.DocEntry IN (${docEntryList(docEntries)})
  AND i.ItmsGrpCod IN (${itemGroupList(itemGroups)})
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
export const grpoWindow = (itemGroups: string | null) => `
SELECT
    gr.DocEntry     AS docEntry,
    gr.DocNum       AS docNum,
    -- prefix ของ GRPO เอง เช่น 'AGP-' / 'PGP-' (0021)
    sg.BeginStr     AS beginStr,
    gr.DocDate      AS docDate,
    gr.UpdateDate   AS updateDate,
    d1.LineNum      AS lineNum,
    d1.ItemCode     AS itemCode,
    d1.Dscription   AS itemDescription,
    d1.Quantity     AS receivedQty,
    d1.BaseType     AS baseType,
    d1.BaseEntry    AS baseEntry,
    d1.BaseLine     AS baseLine,
    po.DocNum       AS basePoNumber,
    -- ★ prefix ของ **PO แม่** ไม่ใช่ของ GRPO — ลืมตัวนี้แล้ว connector จะไปหา
    -- '12608073' ในตารางที่เก็บ 'APO-12608073' → grpo_line ไม่เกิดสักแถว
    -- และ sync จะรายงานว่าสำเร็จ ไม่มีอะไรฟ้อง
    sp.BeginStr     AS basePoBeginStr
FROM OPDN gr
JOIN PDN1 d1 ON d1.DocEntry = gr.DocEntry
JOIN OITM i  ON i.ItemCode  = d1.ItemCode
LEFT JOIN OPOR po ON po.DocEntry = d1.BaseEntry
LEFT JOIN NNM1 sg ON sg.Series = gr.Series AND sg.ObjectCode = '20'
LEFT JOIN NNM1 sp ON sp.Series = po.Series AND sp.ObjectCode = '22'
WHERE i.ItmsGrpCod IN (${itemGroupList(itemGroups)})
  AND (@from IS NULL OR gr.UpdateDate >= @from)
  AND (@to   IS NULL OR gr.UpdateDate <  @to)
ORDER BY gr.UpdateDate, gr.DocEntry, d1.LineNum;`;

// จุดต่ำสุดของประวัติ — ถามครั้งเดียวตอนรอบแรกเพื่อรู้ว่า backfill ต้องถอยถึงไหนแล้วจบ
// (ไม่รู้ค่านี้ = ไม่รู้ว่าเมื่อไหร่ควรเลิกถอย แล้วจะถอยไปเรื่อย ๆ ในอดีตที่ไม่มีข้อมูล)
export const poMinUpdateDate = (itemGroups: string | null) => `
SELECT MIN(po.UpdateDate) AS minUpdateDate
FROM OPOR po
JOIN POR1 p1 ON p1.DocEntry = po.DocEntry
JOIN OITM i  ON i.ItemCode  = p1.ItemCode
WHERE i.ItmsGrpCod IN (${itemGroupList(itemGroups)});`;

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
// ★ ไม่กรอง DprArea — เอาสมุดที่ฐานนั้นมีมาเลย
//
// เดิมเขียน DprArea = '01 Posting' ไว้ตายตัว ซึ่งเป็นชื่อที่ตั้งได้อิสระต่อบริษัท ไม่ใช่
// รหัสมาตรฐานของ SAP: UBA/UBP ตั้งว่า '01 Posting' ส่วน MIG ตั้งว่า 'Main Book'
// ผลคือ MIG ดึงสินทรัพย์เข้ามาครบ 207 ชิ้นแต่ฝั่งบัญชีไม่ match เลยสักแถว มูลค่าเป็น NULL
// ทั้งชุด โดยรอบ sync ยังขึ้น SUCCESS เพราะ LEFT JOIN ไม่ล้ม แค่ไม่เจอ
//
// ตัวกรองนี้ไม่เคย "เลือก" อะไรจริง ๆ — แต่ละฐานมีสมุดเดียวอยู่แล้ว (วัด 2026-09-02:
// UBA มีแต่ '01 Posting' · MIG มีแต่ 'Main Book') มันจึงมีค่าเป็นแค่ข้อสมมติที่ผิดได้เงียบ ๆ
// เอาออกแล้วได้ของชุดเดียวกันเป๊ะสำหรับ UBA/UBP และ MIG กลับมามีมูลค่า
//
// ⚠️ ข้อแลก: ถ้าวันหนึ่งฐานไหนเปิดสมุดที่สอง (เช่นสมุดภาษี) latest จะมีสองแถวต่อ
//    (ItemCode, PeriodCat) แล้ว rn = 1 หยิบมาแบบไม่กำหนดว่าเล่มไหน ส่วน join ITM7 จะได้
//    สองแถวต่อชิ้นแล้ว collapse() หยิบแถวแรก — ทั้งคู่เงียบเหมือนกัน ไม่มีอะไรฟ้อง
//    ถ้าจะกันเคสนั้นต้องเป็นด่านที่ "ตรวจแล้วดังให้เห็น" ไม่ใช่กลับไปเดาชื่อเล่มฝังไว้อีก
//
// UnDpAcc / SpDpAcc1-3 / WriteUpAcc / AppreAcc ดึงมาแต่ไม่มีที่เก็บ — ใช้ตรวจว่ายังเป็น 0
// อยู่ทุกรอบ วันที่บัญชีตัดด้อยค่า/ตีราคาใหม่ ยอดสะสมที่เราเก็บจะต่ำกว่าจริงทันที
//
// ── ★ ACQ1 เข้ามาเพราะ ITM8.APC คือ "ยอดยกมาต้นปีบัญชี" ไม่ใช่ยอดปลายปี
//
// ปีที่ซื้อ APC จึงเป็น 0 เสมอ (ตอนต้นปีของยังไม่เข้ามา) ตัวรายการซื้อจริงอยู่ที่ ACQ1
// แล้วมูลค่าถึงไปโผล่ใน ITM8 ปีถัดไป — ยืนยันกับ COM-100-05-002: ปี 2005 APC=0 /
// ปี 2006 เป็นต้นไป APC=12,871.03 เท่ากับ ACQ1.LineTotal เป๊ะทุกปี
//
// ผลคือของที่เพิ่งซื้อในปีบัญชีปัจจุบันมีแถว ITM8 อยู่แถวเดียวคือแถวปีที่ซื้อ ซึ่ง APC = 0
// (วัด 2026-08-24: 101 จาก 2,726 ชิ้นเป็นแบบนี้ ทั้ง 101 มีแถวเดียวจริง ไม่มีเคสตัดจำหน่าย
//  ปนมาเลย และ 100 ชิ้นในนั้นมียอดจริงใน ACQ1) ถ้าไม่ดึง ACQ1 มาด้วย ของใหม่ทุกชิ้นจะ
// เข้าระบบด้วยมูลค่า 0 โดยรอบ sync ยังขึ้น SUCCESS ตามปกติ ไม่มีอะไรฟ้อง
//
// ★ ต้อง GROUP BY ก่อน join ห้าม join ACQ1 ดิบ ๆ — 11 ชิ้นมีหลายบรรทัด (ซื้อเพิ่ม/ทยอยรับ)
//   join ตรงเมื่อไหร่แถว ITM8 ทุกปีจะถูกคูณตามจำนวนบรรทัด แล้วยอดที่เห็นจะเป็นของ
//   transaction เดียวไม่ใช่ยอดรวม (grain ของ latest/ITM7 ถูกคุมไว้ 1 แถวต่อ ItemCode
//   ทั้งคู่แล้ว ตัวนี้เป็นตัวเดียวที่จะทำให้ผลบานถ้าปล่อยไว้)
//
// ส่งมาเป็นคอลัมน์แยก ไม่ COALESCE ที่นี่ — SQL ยังเป็นภาพตรง ๆ ของ SAP ส่วนกติกาว่า
// เมื่อไหร่ควรถอยไปใช้ตัวไหนอยู่ที่ connector (หลักเดียวกับ DocStatus ที่ส่ง 'O'/'C' ดิบ)
export const legacyAssetAll = () => `
WITH latest AS (
    SELECT b.ItemCode, b.PeriodCat, b.APC, b.APCHist, b.OrDpAcc, b.SalvageVal,
           b.UnDpAcc, b.SpDpAcc1, b.SpDpAcc2, b.SpDpAcc3, b.WriteUpAcc, b.AppreAcc,
           ROW_NUMBER() OVER (PARTITION BY b.ItemCode ORDER BY b.PeriodCat DESC) AS rn
    FROM ITM8 b
),
acq AS (
    SELECT a.ItemCode, SUM(ISNULL(a.LineTotal, 0)) AS acqPostedTotal
    FROM ACQ1 a
    GROUP BY a.ItemCode
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
    l.PeriodCat     AS fiscalYear,
    l.APC           AS bookedCost,
    -- ยอดรวมรายการซื้อทั้งหมดที่เคยเกิดกับชิ้นนี้ — ใช้ถอยไปหาเมื่อ APC ยังเป็น 0
    -- (ดูเหตุผลเต็มที่หัวคิวรี — คนละความหมายกับ APC ห้ามเอามาทับเมื่อ APC มีค่าแล้ว)
    q.acqPostedTotal AS acquisitionPostedTotal,
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
LEFT JOIN acq q     ON q.ItemCode = i.ItemCode
LEFT JOIN ITM7 dp   ON dp.ItemCode = i.ItemCode
                   AND dp.PeriodCat = l.PeriodCat
-- ★ ตัวกรองเปลี่ยนเป็นธง Fixed Asset ของ SAP ตรง ๆ (0021)
--
-- เดิม: ItmsGrpCod IN (...) AND NOT <ตัวเลขล้วน> ซึ่งผูกกับผังกลุ่มของแต่ละบริษัท
-- (UBA 117 / UBP 110 — คนละเลขและ UBP ไม่มีกลุ่ม 117 เลย) และยังเดารูปทรงจาก ItemCode
--
-- ItemType = 'F' เป็นความหมาย ไม่ใช่ผัง จึงใช้ได้ทุกบริษัทโดยไม่ต้องส่ง itemGroups
-- และเก็บของที่ตัวกรองเดิมมองไม่เห็นให้ด้วย (UBA มีสินทรัพย์ 5 ตัวอยู่กลุ่ม 100)
--
-- ⚠️ ใช้กับคิวรีนี้เท่านั้น — ฝั่ง PO/GRPO ห้ามใช้ เพราะบรรทัดเอกสารอ้าง "รหัสจัดซื้อ"
--    ซึ่งเป็น ItemType = 'I' ทั้งหมด (UBA 5 ตัว / UBP 2 ตัว) เปลี่ยนแล้วจะ match ไม่ได้เลย
WHERE i.ItemType = 'F'
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
export const purchasingItemAll = (itemGroups: string | null) => `
SELECT
    i.ItemCode      AS itemCode,
    i.ItemName      AS description,
    i.AssetClass    AS assetClass,
    i.InvntryUom    AS uom
FROM OITM i
WHERE i.ItmsGrpCod IN (${itemGroupList(itemGroups)})
  -- เงื่อนไขเสริมที่ตรงกับข้อมูลจริง: รหัสจัดซื้อเป็น ItemType = 'I' ทั้งหมด
  -- (UBA 5/5 · UBP 2/2) กันของแปลกปนถ้าวันหลังมีคนตั้งรหัสตัวเลขล้วนเป็น 'F'
  AND i.ItemType = 'I'
  AND ${purchasingCodeSqlFilter('i.ItemCode')}
ORDER BY i.ItemCode;`;

// ไม่มี BaseType ที่นี่โดยตั้งใจ — ขอบเขตต้องตรงกับ grpoWindow เป๊ะ ถ้ากรองแคบกว่าจะได้
// MIN ที่ใหม่เกินจริง แล้ว backfill จะหยุดถอยก่อนเวลา ทำให้ GRPO แบบไม่มี PO ที่เก่ากว่านั้น
// ไม่มีวันถูกเก็บ และไม่มีอะไรบอกด้วยว่าหยุดเร็วไป
export const grpoMinUpdateDate = (itemGroups: string | null) => `
SELECT MIN(gr.UpdateDate) AS minUpdateDate
FROM OPDN gr
JOIN PDN1 d1 ON d1.DocEntry = gr.DocEntry
JOIN OITM i  ON i.ItemCode  = d1.ItemCode
WHERE i.ItmsGrpCod IN (${itemGroupList(itemGroups)});`;
