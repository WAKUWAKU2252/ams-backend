// ข้อมูลฝั่ง SAP ที่ AMS อ่านอย่างเดียว ไม่ได้เป็นคนสร้าง
import { pgTable, pgEnum, varchar, date, uuid, integer, numeric, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from '@intrastucture/db/schema/shared/iso-timestamp';
import { employee } from './master';
import { company } from './company';

// สถานะใบสั่งซื้อฝั่ง SAP (OPOR.DocStatus) — 'O' = Open, 'C' = Closed
// เก็บเป็นคำเต็มไม่ใช่ตัวอักษรเดียว เพราะ 'O'/'C' อ่านไม่ออกถ้าไม่เปิดคู่มือ SAP
export const enumPoDocStatus = pgEnum('po_doc_status', ['OPEN', 'CLOSED']);

// ไม่มีคอลัมน์ status โดยตั้งใจ — "รับครบหรือยัง" เป็นเลขคณิต (Σ receivedQty เทียบ quantity)
// ที่คำนวณสดได้เสมอ SAP ก็ไม่ได้ส่งค่านี้มาให้ การเก็บซ้ำจึงมีแต่ภาระต้องคอยอัปเดตทุกครั้ง
// ที่ grpo_line เปลี่ยน (เพิ่ม/แก้/ลบ/sync จาก SAP) ลืมจุดเดียวคอลัมน์ก็โกหกทันที
// โดยที่คนอ่านไม่มีทางรู้ — ดู receivedStatus ใน purchase-order.service แทน
export const purchaseOrder = pgTable(
  'purchase_order',
  {
    // ── เลขเต็มพร้อม prefix เช่น 'APO-62605007' / 'PPO-12608073' (0021)
    //
    // เดิมเก็บ OPOR.DocNum เปล่า ๆ ('62605007') ซึ่งตัดตัวตนทิ้งไปครึ่งหนึ่ง — SAP สอง
    // บริษัทเดินเลขในช่วงเดียวกันเป๊ะ เลขเปล่าจึงชนกันข้ามบริษัท และยังชนข้ามชนิดเอกสาร
    // ด้วย (PO หลักนำ 1 กับ GRPO สาย AGP- ใช้ช่วง 1YYMMNNN เหมือนกัน)
    //
    // prefix มาจาก NNM1.BeginStr ซึ่งมี '-' ติดมาในค่าอยู่แล้ว ต่อ DocNum ตรง ๆ ไม่ต้องเติม
    // เก็บเป็นสตริงเดียวโดยตั้งใจ ไม่แตกเป็น composite key: poNumber ถูกอ้าง 148 จุดใน
    // 24 ไฟล์ รวม route param และ payload ของ Teams — prefix แก้ปัญหาได้ครบโดยไม่ต้องแตะ
    poNumber: varchar({ length: 50 }).primaryKey().notNull(),
    // บริษัทเจ้าของใบ — ต้องมีแยกจาก prefix เพราะ prefix ใช้ตอบได้แค่กับเลขเอกสาร
    // ส่วน employee.ownerCode / itemCode ไม่มี prefix ติดมาให้แยก
    companyCode: varchar({ length: 20 }).notNull(),
    // OPOR.DocEntry — PK จริงฝั่ง SAP ที่ไม่มีวันเปลี่ยน (DocNum ซ้ำข้าม series ได้)
    // ก่อนหน้านี้ poWindow() select มาอยู่แล้วแต่ทิ้งไปเฉย ๆ
    docEntry: integer(),
    vendorName: varchar({ length: 100 }),
    poDate: date(),
    // ── ผู้ขอซื้อ (OwnerPR) — คนที่เปิดใบขอซื้อฝั่ง SAP
    //
    // ชื่อเดิมคือ requesterName/requesterId เปลี่ยนเป็น ownerPr* ใน 0009 เพราะ "requester"
    // ไปชนกับคนอีกคนที่ระบบเพิ่งเริ่มแยก: RequestBy = คนกดส่งคำขอลงทะเบียนใน AMS
    // ซึ่งคนละคนกันได้บ่อย (ใบคำขอเป็นของกลางต่อ PO ใครก็เข้ามากรอกต่อได้)
    // ใช้คำว่า requester ต่อไปจะอ่านผิดกันทั้งทีมว่าหมายถึงใคร
    //
    // 200 ไม่ใช่ 100: ค่ามาจาก OHEM.firstName + ' ' + lastName ซึ่งเป็น nvarchar(50)
    // ทั้งคู่ = ยาวได้ถึง 101 ตัวอักษร ถ้าตั้ง 100 จะพังทั้งหน้าต่าง sync ตอนเจอชื่อยาว
    ownerPrName: varchar({ length: 200 }),
    // FK ไป employee.id (เลขเรียงของ AMS) ไม่ใช่ OwnerCode ของ SAP
    // sync เชื่อมให้สองต่อ: OPOR.OwnerCode -> employee.ownerCode -> employee.id
    // (ownerPrName เป็นแค่ชื่อโชว์ ใช้ตัดสิน routing ไม่ได้เพราะซ้ำ/สะกดเพี้ยน); nullable รองรับ PO เก่า
    ownerPrId: integer(),
    // สถานะใบจาก SAP — nullable โดยตั้งใจ ไม่ใส่ default 'OPEN'
    // แถวที่ sync มาก่อน 0005 ไม่มีใครรู้สถานะจริง การ default เป็น OPEN จะทำให้ใบที่
    // ปิดไปแล้วโกหกว่ายังเปิดอยู่ — NULL แปลว่า "ยังไม่เคยดึงค่านี้มา" ซึ่งเป็นความจริง
    // ⚠️ จะเป็น NULL ทั้งตารางจนกว่าจะต่อ sync ให้ดึง OPOR.DocStatus มาเติม
    docStatus: enumPoDocStatus(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    // ไม่ cascade: ลบ employee ที่เคยเป็นผู้ขอ PO ไม่ได้ (ประวัติต้องอยู่)
    foreignKey({
      columns: [table.ownerPrId],
      foreignColumns: [employee.id],
      name: 'fk_purchase_order_owner_pr',
    }),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอน join หาแผนกของผู้ขอ
    index('idx_purchase_order_owner_pr_id').on(table.ownerPrId),
    // ไม่ cascade: ลบบริษัทที่ยังมีเอกสารอยู่ไม่ได้
    foreignKey({
      columns: [table.companyCode],
      foreignColumns: [company.code],
      name: 'fk_purchase_order_company',
    }),
    index('idx_purchase_order_company_code').on(table.companyCode),
    // ตัวตนจริงฝั่ง SAP — ห้ามซ้ำภายในบริษัทเดียวกัน (ข้ามบริษัทซ้ำได้ คนละฐาน)
    // nullable ได้หลายแถวใน pg จึงไม่บล็อกแถวเก่าที่ยังไม่มี docEntry
    unique('uq_purchase_order_doc_entry').on(table.companyCode, table.docEntry),
  ],
);

export const purchaseOrderItem = pgTable(
  'purchase_order_item',
  {
    id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
    poLine: integer().notNull(),
    // รหัสสินค้าฝั่ง SAP (OITM.ItemCode) — ต้องเก็บ ไม่ใช่ใช้กรองแล้วทิ้ง:
    // เลข asset ที่ Finance เก็บใน Excel ผูกกับรหัสนี้ การเติมเลข asset ให้ของเก่า
    // จึงต้อง join ผ่านคอลัมน์นี้ ถ้าไม่มีก็ไม่เหลืออะไรให้ match เลย
    // (itemDescription ใช้แทนไม่ได้ — ข้อความซ้ำและสะกดเพี้ยนได้)
    itemCode: varchar({ length: 50 }),
    // กลุ่มสินค้า (OITM.ItmsGrpCod) — ขอบเขตจริงมาจาก SAP_ITEM_GROUPS ใน .env
    // ปัจจุบันคือ 117 (fixed asset) อย่างเดียว; 114 (expense) เคยรวมแล้วถอดออก
    // เก็บไว้เพราะตัวกรองอยู่ฝั่ง SAP: ถ้าไม่บันทึกว่าแถวนี้เข้ามาด้วยเหตุผลอะไร
    // ภายหลังจะแยกไม่ออกว่าอันไหนเป็นสินทรัพย์จริง อันไหนเป็นค่าใช้จ่าย
    itemGroup: integer(),
    itemDescription: varchar().notNull(),
    // numeric ไม่ใช่ integer: POR1.Quantity ฝั่ง SAP เป็น numeric(19,6) และมีของที่นับ
    // เป็นเศษจริง (กก./ตัน) ตอนเป็น integer เคยพังมาแล้วด้วย pg 22P02 ตอนลองรวมกลุ่ม 114
    // — ผู้ใช้ยังเห็นเป็น "จำนวนชิ้น" เหมือนเดิม ฝั่ง service ปัดขึ้นตอนสร้างช่องกรอก
    quantity: numeric({ mode: 'number' }).notNull(),
    unitPrice: numeric({ mode: 'number' }).notNull(),
    poNumber: varchar({ length: 50 }).notNull(),
    // ยอดรวมจริงต่อบรรทัดจาก SAP (อาจ ≠ quantity × unitPrice เมื่อมีส่วนลด/ค่าขนส่ง) — ใช้เป็นเพดาน over-cost
    lineTotal: numeric({ mode: 'number' }).notNull(),
    // ข้อมูล SAP sync — timestamp ให้สาวได้ว่าแถวเข้า/แก้เมื่อไหร่ (Finding #11)
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.poNumber],
      foreignColumns: [purchaseOrder.poNumber],
      name: 'fk_purchase_order_item_po_number',
    }).onDelete('cascade'),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ต้องมีเพื่อ join items ของ PO และ cascade delete
    index('idx_purchase_order_item_po_number').on(table.poNumber),
    // กุญแจธรรมชาติของบรรทัด PO ฝั่ง SAP — id เป็น uuid ที่ AMS สร้างเอง ใช้จับคู่กับ SAP ไม่ได้
    // ต้องมีเพื่อให้ sync ทำ upsert ได้ (ON CONFLICT ต้องการ unique constraint ไม่ใช่ index เฉย ๆ)
    // ขาดตัวนี้ = รัน sync ซ้ำแล้วได้บรรทัดซ้ำทวีคูณ และ uuid ที่ asset/grpo_line อ้างอยู่จะกำกวม
    unique('uq_purchase_order_item_po_line').on(table.poNumber, table.poLine),
    // ใช้ค้นว่ารหัสสินค้านี้ถูกซื้อในบรรทัดไหนบ้าง — เป็นทางเข้าหลักตอนจับคู่เลข asset
    // จาก Excel ของ Finance (1 รหัส → หลายบรรทัด หลายปี)
    index('idx_purchase_order_item_item_code').on(table.itemCode),
  ],
);
