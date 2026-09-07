// ═══════════════════════════════════════════════════════════════════════════
// Master data — ตรงกับ Masterdata.xlsx sheet Category / Uom / Department /
// Asset location / Asset sub location / Employee
//
// กติกาที่ใช้ร่วมกันทุกตารางในกลุ่มนี้:
//   - ชื่อที่ผู้ใช้เห็นต้อง UNIQUE — ถ้าซ้ำได้ dropdown จะมีตัวเลือกหน้าตาเหมือนกันเป๊ะ
//     ผู้ใช้เลือกคนละ id แล้วรายงานแยกกลุ่มเพี้ยนถาวรโดยไม่มีใครรู้
//   - isActive แทนการลบ — แถวที่ถูก asset อ้างถึงแล้วลบจริงไม่ได้ (FK กันอยู่)
//     ต้องปิดใช้เพื่อไม่ให้โผล่ใน dropdown ใหม่ แต่ของเก่ายังชี้ได้อยู่
//   - createdAt/updatedAt ครบทุกตาราง — ข้อมูลอ้างอิงเปลี่ยนแล้วต้องสาวกลับได้ว่า
//     เปลี่ยนเมื่อไหร่ (วัตถุประสงค์ข้อ 4 ของโปรเจกต์: รองรับการตรวจสอบภายใน)
// ═══════════════════════════════════════════════════════════════════════════
import { pgTable, serial, varchar, integer, boolean, jsonb, check, foreignKey, index, unique, primaryKey, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from '@intrastucture/db/schema/shared/iso-timestamp';
import { company } from './company';

export const category = pgTable(
  'category',
  {
    id: serial().primaryKey().notNull(),
    // รหัสบัญชีจาก SAP — ท่อนแรกของ OITM.AssetClass ('1216401-0-775' → '1216401') เพิ่มใน 0011
    //
    // เป็นคีย์ธรรมชาติที่ connector ใช้ resolve หมวด: ชื่อไทยแก้ได้ตลอดโดยไม่พัง sync
    // ส่วนรหัสบัญชีเปลี่ยนเมื่อบัญชีปรับผังเท่านั้น (ถ้าเปลี่ยนต้องมาแก้ที่นี่ ซึ่งควรรู้ตัว)
    // ผูกด้วยชื่อไม่ได้: OACT เรียก 'เครื่องใช้สำนักงาน' แต่ dropdown ของเราอาจเรียกอย่างอื่น
    code: varchar({ length: 20 }).notNull(),
    name: varchar({ length: 100 }).notNull(),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [unique('uq_category_name').on(table.name), unique('uq_category_code').on(table.code)],
);

// ตาราง uom ถูกถอดออกใน 0012 — หน่วยนับย้ายไปเป็นคอลัมน์ asset.uom (varchar) ตรง ๆ
//
// ข้อมูลจริงจาก OITM.InvntryUom มี 13 ค่า (ตัว/เครื่อง/ชิ้น/ชุด/ใบ/หน่วย/ตู้/อัน/หลัง/แปลง/
// คัน/ผืน/Set) ยาวสุด 7 อักษร ไม่มี field อื่นให้เก็บนอกจากชื่อ และ AMS ไม่ได้เป็นเจ้าของ
// ค่าชุดนี้ — SAP เป็นคนกำหนด เราแค่คัดลอกมาแสดง ตารางแยกจึงมีแต่ต้นทุน (FK + CRUD +
// dropdown ที่แก้แล้วไม่มีผลกลับไปหา SAP) โดยไม่ได้อะไรกลับมา
// ตอนถอด: ทั้งตาราง uom และ asset.uomId ไม่มีข้อมูลสักแถว (0 rows / 0 non-null)

export const department = pgTable(
  'department',
  {
    id: serial().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    shortName: varchar({ length: 20 }),
    // ── บริษัทเจ้าของแผนก (0024) — เดิมตารางนี้เป็นของ UBA ล้วนจึงไม่มีคอลัมน์นี้ ──
    //
    // ⚠️ ต้องมี ไม่ใช่ของแถม: แผนกของ MIG ชนกับของ UBA **32 จาก 33 รหัส** และชื่อตรงกัน
    //    เป๊ะอีก 18 ชื่อ (Information Technology / Human Resources / Finance / Executive ...)
    //    เพราะทั้งเครือใช้ผังรหัส cost center ชุดเดียวกัน
    //
    // ★ ถ้าปล่อยให้ใช้แถวร่วมกันจะไม่ใช่แค่ "ข้อมูลปนกัน" — department.managerId คือคน
    //   ที่ระบบส่งการ์ดขออนุมัติเข้า Teams ไปหา แผนก 110 แถวเดียวมีหัวหน้าได้คนเดียว
    //   คำขอของ MIG จึงจะวิ่งไปหาหัวหน้าของ UBA ทุกใบ ซึ่งเรียกคืนไม่ได้
    companyCode: varchar({ length: 20 }).notNull(),
    // รหัสแผนกจากระบบ HR ภายนอก (depCode) — ไม่ใช่ id ของตารางนี้
    // ใช้เป็นคีย์ธรรมชาติตอนนำเข้าข้อมูล ทำให้รันสคริปต์อิมพอร์ตซ้ำได้โดยไม่เกิดแถวซ้ำ
    // ซ้ำไม่ได้ **ภายในบริษัทเดียวกัน**: ถ้าซ้ำ พนักงานจะถูกผูกเข้าแผนกผิดโดยไม่มีใครรู้
    departmentId: varchar({ length: 100 }),
    // หัวหน้าแผนก (ผู้อนุมัติคำขอลงทะเบียนของแผนกนี้) — ชี้ employee ไม่ใช่ user เพื่อเลี่ยง
    // circular import master<->user; ตอนอนุมัติ resolve เป็น user ผ่าน user.employeeId (role MANAGER)
    // ใช้ .references แบบ lazy เพราะ employee ถูกนิยามทีหลังในไฟล์เดียวกัน (mutual FK) — table-level อ้าง employee.id ไม่ได้ตอน eval
    // annotate return เป็น AnyPgColumn เพื่อตัด circular type: department↔employee อ้างกันไป-กลับ ถ้าไม่ตัด TS ไล่ type วนไม่จบ
    // แล้วยอมให้ทั้งสองตารางเป็น any ทำให้ db.query...with ทั้งระบบพังตาม (TS7022)
    managerId: integer().references((): AnyPgColumn => employee.id),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    // ── คีย์ธรรมชาติเป็น (บริษัท, รหัส) ตั้งแต่ 0024 — เดิมเป็นรหัสเดี่ยว ────────
    // เปลี่ยนเพราะรหัสเป็นผังของแต่ละบริษัท ไม่ใช่เลขที่ไม่ซ้ำกันทั้งเครือ (MIG ชน UBA 32/33)
    unique('uq_department_hr_id').on(table.companyCode, table.departmentId),
    // เพิ่มใน 0006 — ตารางนี้เป็น master table เดียวที่ขาดไป (category/uom/asset_location มีครบ)
    // ผลของการขาด: import ชุดใหม่ที่คีย์ธรรมชาติไม่ตรงชุดเก่าจะ insert เพิ่มทั้งชุดแทนที่จะชน
    // แล้วได้แผนกชื่อเดียวกันสองแถว ซึ่ง dropdown แยกไม่ออกและรายงานแตกเป็นสองก้อนถาวร
    // (เกือบเกิดจริงตอนสลับคีย์จาก OUDP.Code เป็นรหัส profit center)
    //
    // ⚠️ ผูกบริษัทเข้าไปด้วยใน 0024 — เจตนาเดิม ("ชื่อซ้ำ = แผนกเดียวกัน") ใช้ได้เฉพาะ
    //    ภายในบริษัท ข้ามบริษัทชื่อซ้ำเป็นเรื่องปกติ (18 ชื่อระหว่าง MIG กับ UBA)
    //    ผลข้างเคียงที่ต้องรับ: dropdown จะมีชื่อซ้ำข้ามบริษัทจริง ๆ ฝั่งที่เรียกต้องกรอง
    //    ด้วย companyCode หรือแสดงชื่อบริษัทกำกับ — ดู findDepartments()
    unique('uq_department_name').on(table.companyCode, table.name),
    // ไม่ cascade: ลบบริษัทที่ยังมีแผนกอยู่ไม่ได้ (หลักเดียวกับ purchase_order/grpo/asset)
    foreignKey({
      columns: [table.companyCode],
      foreignColumns: [company.code],
      name: 'fk_department_company',
    }),
    index('idx_department_company_code').on(table.companyCode),
    // ไม่ได้กันอะไรเพิ่ม (id เป็น PK อยู่แล้ว) แต่เป็นปลายทางที่จำเป็นให้ employee_company
    // ทำ composite FK (departmentId, companyCode) ได้ → แผนกที่ผูกไว้จะข้ามบริษัทไม่ได้
    // ต้องเป็น unique() ไม่ใช่ uniqueIndex(): drizzle-kit introspect unique index ที่ขึ้นต้น
    // ด้วย primary key ไม่ติด แล้วสั่งสร้างซ้ำทุกครั้งจน push พังถาวร (เคสจริง: uq_attachment_id_doc_type)
    unique('uq_department_id_company').on(table.id, table.companyCode),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอนหาแผนกที่ user คนนี้เป็นหัวหน้า
    index('idx_department_manager_id').on(table.managerId),
  ],
);

export const assetLocation = pgTable('asset_location', {
  id: serial().primaryKey().notNull(),
  // คีย์ธรรมชาติที่คนตั้งเอง เช่น "HQ", "PLANT1" — เพิ่มใน 0007
  // id เป็น serial จึงได้เลขไม่ตรงกันระหว่างเครื่อง อ้างอิงข้ามระบบ/ข้ามไฟล์ด้วย id ไม่ได้
  // ใช้เป็นคีย์ ON CONFLICT ตอน import ให้รันซ้ำได้ (แบบเดียวกับ department.departmentId)
  code: varchar({ length: 50 }).notNull(),
  name: varchar({ length: 100 }).notNull(),
  // id ของสถานที่เดียวกันฝั่ง SAP (OLCT.Code ซึ่ง OITM.Location ชี้มา) — เพิ่มใน 0011
  //
  // 52 แถวในตารางนี้ import มาจาก OLCT ตรง ๆ และวันนี้ id บังเอิญตรงกันทุกแถว แต่ห้าม
  // ให้ connector พึ่งความบังเอิญนั้น: id เป็น serial ซึ่งบนเครื่องอื่น/หลัง import รอบใหม่
  // จะไม่ตรง แล้วสินทรัพย์ทั้งกองจะถูกวางผิดที่แบบเงียบ ๆ (เหตุผลเดียวกับ asset_sub_location.code)
  // NULL = สถานที่นี้สร้างใน AMS เอง ไม่มีคู่ใน SAP — sync จะไม่มีวันเลือกแถวนี้
  sapLocationId: integer(),
  // mapUrl ถูกถอดออกใน 0007 — ตั้งใจให้เก็บผังระดับอาคาร แต่ผังจริงอยู่ระดับห้อง
  // และไฟล์ผังย้ายไปเป็น static asset ฝั่ง frontend (/floorplans/<planKey>.png) แล้ว
  // จึงไม่ต้องเก็บ path ใน DB อีก — ไม่เคยมีแถวไหนมีค่าและไม่เคยมีโค้ดอ่าน
  //
  // ── ตารางนี้ถือของสองชนิดตั้งแต่ 0022 (0023 เพิ่มตัวแยกให้) ────────────────
  // false = สถานที่ทางบัญชี ยกมาจาก OLCT.Location ของ SAP 52 แถว — เป็นค่าที่ผู้ใช้
  //         เลือกใส่ asset.locationId แล้วส่งต่อให้บัญชี
  // true  = "ตึก" ที่ 0022 เพิ่มเข้ามาเพื่อให้ asset_sub_location.locationId มีที่ห้อย
  //         (UBIS-B1/B2/B3/OUT) ไม่ใช่สถานที่ทางบัญชี ห้ามโผล่ใน dropdown ให้คนเลือก
  //
  // ★ ทำไมต้องมีคอลัมน์ ไม่กรองด้วย code LIKE 'UBIS-%': พอมีไซต์ที่สอง prefix จะไม่ใช่
  //   UBIS แล้วตัวกรองจะเงียบ ๆ ปล่อยตึกหลุดเข้า dropdown บัญชี — และ isActive ใช้แทนไม่ได้
  //   เพราะความหมายคนละเรื่อง (เลิกใช้ ≠ คนละชนิด) คนถัดไปจะเปิดมันกลับด้วยความหวังดี
  //
  // สองแกนนี้ไม่ต้องตรงกันและตั้งใจให้ไม่ตรง: asset.locationId = แกนบัญชี ส่วนตึกที่
  // ของชิ้นนั้นตั้งอยู่จริง derive จาก asset.subLocationId เอา ไม่ได้เก็บซ้ำบน asset
  isPlanArea: boolean().default(false).notNull(),
  /**
   * สถานที่ทางบัญชีที่ของจริง "อยู่นอกผังของไซต์นี้" — เช่น ส่งไปต่างประเทศ / สาขาอื่น
   *
   * ── แกนที่สาม ไม่ใช่ตัวเดียวกับ isPlanArea ข้างบน
   *
   *   isPlanArea = true   → "ตึก" ที่ห้องห้อยอยู่ (เลือกเป็น asset.locationId ไม่ได้เลย)
   *   isPlanArea = false  → สถานที่ทางบัญชีจาก OLCT ที่ผู้ใช้เลือกได้ ซึ่งแตกเป็นสองพวก:
   *       outPlan = false → อยู่ในผังนี้   ต้องเลือกห้อง + ปักหมุด
   *       outPlan = true  → อยู่นอกผังนี้  ไม่มีห้องให้เลือกและไม่มีจุดให้ปัก
   *
   * ★ ต้องเป็นคอลัมน์ เพราะ derive จากอย่างอื่นไม่ได้จริง ๆ: "ต่างประเทศ" กับ "สำนักงานใหญ่"
   *   เป็นแถวหน้าตาเหมือนกันทุกช่อง (code/name/sapLocationId ยกมาจาก OLCT เหมือนกัน)
   *   ต่างกันแค่ความรู้ทางธุรกิจซึ่งไม่เคยถูกบันทึกไว้ที่ไหนในระบบมาก่อน
   *
   * ★ ห้ามใช้ code LIKE เป็นตัวแยกแทน — เหตุผลเดียวกับ isPlanArea ข้างบนเป๊ะ: รหัสชุดนี้
   *   เป็นของ SAP เราไม่ได้เป็นเจ้าของ เขาเปลี่ยนเมื่อไหร่ตัวกรองเงียบไปเฉย ๆ
   *
   * ★ ห้ามใช้ isActive แทน — "อยู่ไกล" ไม่ใช่ "เลิกใช้" ของที่ส่งไปต่างประเทศยังต้องเลือก
   *   สถานที่นี้ได้ตามปกติ ถ้าปิดใช้งานมันจะหายจาก dropdown ทั้งที่ยังต้องใช้อยู่
   *
   * default false = ของเดิมทั้ง 52 แถวยังทำงานเหมือนเดิม (ต้องมีห้อง+หมุด) แล้วค่อยติดธง
   * ให้เฉพาะแถวที่อยู่นอกผังทีหลัง — ไม่มีอะไรเปลี่ยนพฤติกรรมจนกว่าจะมีคน UPDATE
   */
  outPlan: boolean().default(false).notNull(),
  isActive: boolean().default(true).notNull(),
  createdAt: isoTimestamp().default(sql`now()`).notNull(),
  updatedAt: isoTimestamp().default(sql`now()`).notNull(),
}, (table) => [
  // ชื่อสถานที่ต้อง unique ตามกฎหัวไฟล์ (ชื่อที่ผู้ใช้เห็นห้ามซ้ำ) — ซ้ำแล้ว dropdown เลือกคนละ id รายงานแตกก้อน
  unique('uq_asset_location_name').on(table.name),
  unique('uq_asset_location_code').on(table.code),
  // ห้ามสองแถวอ้าง OLCT แถวเดียวกัน ไม่งั้น resolve ได้หลายคำตอบแล้วเลือกมั่ว
  // (pg ยอมให้ NULL ซ้ำได้ สถานที่ที่สร้างเองจึงไม่ติดข้อนี้)
  unique('uq_asset_location_sap_id').on(table.sapLocationId),
]);

export const assetSubLocation = pgTable(
  'asset_sub_location',
  {
    id: serial().primaryKey().notNull(),
    // คีย์ธรรมชาติ เช่น "B102-INV-01" — เพิ่มใน 0007 ด้วยเหตุผลเดียวกับ asset_location.code
    // ใช้ id แทนไม่ได้ — ห้องเดียวกันเป็น id 5 บนเครื่อง dev แต่เป็น 23 บน prod
    // แล้วขอบเขตห้อง/หมุดตำแหน่งจะไปโผล่ทับห้องอื่นโดยไม่มีอะไรฟ้อง
    //
    // ⚠️ code ไม่ใช่ชื่อไฟล์ผังแล้ว (เคยเป็นตอน 0007 สมัยที่ออกแบบเป็นรูปละห้อง)
    //    ชื่อไฟล์ย้ายไปอยู่ planKey ข้างล่าง — อย่ากลับไปตัดสตริงจาก code เพื่อเดาชื่อไฟล์
    code: varchar({ length: 50 }).notNull(),
    locationId: integer().notNull(),
    // text ไม่ใช่ number: มีชั้นที่ไม่ใช่ตัวเลข เช่น B1, M
    floor: varchar({ length: 100 }),
    room: varchar({ length: 100 }),
    remark: varchar({ length: 255 }),
    // ── ผังชั้น (0022) ────────────────────────────────────────────────────
    // ผังเป็น "แผ่นใหญ่ใบเดียวต่อชั้น" ไม่ใช่รูปละห้อง: ห้องทั้งชั้นใช้ไฟล์เดียวกัน
    // แล้ว frontend ซูม/เลื่อนไปหาห้องที่เลือกโดยใช้ polygon ข้างล่างเป็นเป้า
    //
    // เก็บแค่ "ชื่อไฟล์" ตัวไฟล์จริงอยู่ฝั่ง frontend ที่ public/floorplans/<planKey>.png
    // (ผังเปลี่ยนปีละครั้งสองครั้ง เป็นของที่ deploy ไปพร้อมโค้ด ไม่ใช่ของที่ผู้ใช้อัปโหลด
    //  จึงไม่ต้องมี upload flow / attachment / auth ให้ดูแล และ CDN cache ได้เต็มที่)
    //
    // ⚠️ ค่านี้ต้องเหมือนกันทุกห้องที่ locationId + floor เดียวกัน — ไม่มี FK บังคับให้
    //    (ตัดสินใจไม่เพิ่มตาราง asset_floor_plan เพราะเล็กเกินไป) ตอนเพิ่ม endpoint
    //    สร้าง/แก้ห้อง ต้องให้ service ยึด planKey ของกลุ่มเดิมเสมอ ไม่ใช่รับค่าจาก client ตรง ๆ
    //    ระหว่างนี้ใช้คิวรีตรวจ drift ใน docs/ ดูเป็นระยะ
    planKey: varchar({ length: 50 }),
    // ขอบเขตห้องบนผังชั้น — [[x,y], [x,y], ...] เป็น "สัดส่วนของภาพ" 0–1 เหมือน
    // asset.posX/posY (เหตุผลเดียวกันเป๊ะ: ย่อ/ขยายภาพยังไงก็ตรง ครอปใหม่เมื่อไหร่พังทั้งชุด)
    // ที่ trace ไว้อยู่ใน tools/Map/Sublocation-floor*.json
    //
    // jsonb ไม่ใช่ PostGIS geometry: ไม่มี spatial query สักอันในระบบ — hit-test ว่าคลิกโดน
    // ห้องไหนทำฝั่ง client และพิกัดเป็นสัดส่วนไร้หน่วย ไม่ใช่พิกัดภูมิศาสตร์
    polygon: jsonb().$type<[number, number][]>(),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [assetLocation.id],
      name: 'fk_asset_sub_location_location',
    }),
    index('idx_asset_sub_location_location_id').on(table.locationId),
    // กันสร้างจุดเดิมซ้ำ (อาคารเดียวกัน ชั้น 2 ห้อง 201 ถูกเพิ่มสองครั้ง) ซึ่งจะทำให้
    // asset สองชิ้นอยู่ห้องเดียวกันจริงแต่ชี้คนละ id — รายงานตามสถานที่จะแตกเป็นสองก้อน
    //
    // ⚠️ ตัวนี้บังคับได้ก็ต่อเมื่อ "ตึกถูกแยกเป็น asset_location คนละแถว" (0022 เพิ่ม
    //    UBIS-B1/B2/B3/OUT เข้ามาด้วยเหตุผลนี้ตรง ๆ) — ชื่อห้องซ้ำข้ามตึกเป็นเรื่องปกติ
    //    ของไซต์นี้ มีจริง 4 คู่: ชั้น 1 warehouse01 / warehouse02 / โซนผลิต,
    //    ชั้น 2 ห้องน้ำชั้น2 ถ้าวันไหนยุบตึกทั้งหมดกลับไปอยู่ location เดียว
    //    unique ตัวนี้จะบล็อกการ import ทันที ตอนนั้นต้องถอดมัน ไม่ใช่แก้ชื่อห้อง
    //
    // schema ตรงนี้เป็น plain unique เพราะ drizzle-kit push introspect NULLS NOT DISTINCT ไม่เห็น
    // (ถ้าใส่ .nullsNotDistinct() push จะ re-add ไม่จบ) — ตัวจริงที่รันบน server มี NULLS NOT DISTINCT
    // เติมมือไว้ใน migration 0000_init.sql แล้ว (Finding #4): floor/room NULL ได้ ถ้าไม่ใส่ NULLS NOT
    // DISTINCT pg จะยอม (loc,NULL,NULL) ซ้ำได้ไม่จำกัด → dev (push) ยังเป็น plain แต่ deploy ถูกต้อง
    unique('uq_asset_sub_location').on(table.locationId, table.floor, table.room),
    // ต้องไม่ซ้ำทั้งระบบ ไม่ใช่แค่ในสถานที่เดียวกัน — code เป็นคีย์ที่สคริปต์ import
    // กับเอกสารอ้างถึงห้องโดยตรง ซ้ำเมื่อไหร่ = upsert ไปลงผิดแถวแบบเงียบ ๆ
    unique('uq_asset_sub_location_code').on(table.code),
    // ── กติกาของขอบเขตห้อง (0022) — บังคับที่ DB ด้วยเหตุผลเดียวกับ ck_asset_pos_*
    //    คือ service ไม่ใช่ทางเข้าเดียว: ห้องชุดแรกเข้าระบบด้วยสคริปต์ import ที่เขียน SQL ตรง
    //
    // ต้องรู้ก่อนว่าอยู่บนผังใบไหน — polygon ลอย ๆ ที่ไม่รู้ว่าวาดทับรูปอะไรคือขยะ
    check(
      'ck_asset_sub_location_polygon_needs_plan',
      sql`${table.polygon} IS NULL OR ${table.planKey} IS NOT NULL`,
    ),
    // รูปร่างถูกต้อง: array ของคู่ [x,y] ที่เป็นตัวเลข 0–1 อย่างน้อย 3 จุด
    //   - น้อยกว่า 3 จุด = ไม่ใช่รูปปิด วาดไม่ได้
    //   - หลุด 0–1 = ขอบห้องไปอยู่นอกรูป ซูมไปแล้วไม่เจอ
    // ใช้ jsonpath (@?) แทน subquery เพราะ CHECK ห้ามมี subquery แต่ jsonb_path_exists
    // เป็น IMMUTABLE เรียกใน CHECK ได้ — และไม่ต้องสร้าง function เพิ่มใน DB
    //
    // ⚠️ ต้องมีคำว่า strict — โหมด lax (ค่าเริ่มต้น) จะ "แกะ" array ซ้อนให้อัตโนมัติ
    //    `$[*]` บน [[x,y],...] จึงคืนตัวเลขข้างในแทนที่จะคืนคู่ [x,y] แล้ว @.type() != "array"
    //    เป็นจริงทุกจุด = polygon ที่ถูกต้องโดนบล็อกหมด (ยืนยันบน PGlite แล้ว)
    check(
      'ck_asset_sub_location_polygon_shape',
      sql`${table.polygon} IS NULL OR (
            jsonb_typeof(${table.polygon}) = 'array'
            AND jsonb_array_length(${table.polygon}) >= 3
            AND NOT ${table.polygon} @? 'strict $[*] ? (@.type() != "array" || @.size() != 2)'
            AND NOT ${table.polygon} @? 'strict $[*][*] ? (@.type() != "number" || @ < 0 || @ > 1)'
          )`,
    ),
  ],
);

export const employee = pgTable(
  'employee',
  {
    // เลขเรียงของ AMS เอง ไม่ผูกกับระบบไหน — รหัสของ SAP กับ HR เป็นคนละชุดและ
    // เปลี่ยนได้ ถ้าเอาอันใดอันหนึ่งมาเป็น PK ระบบจะผูกติดกับระบบนั้นถาวร
    id: serial().primaryKey().notNull(),
    // ── ชื่อมาก่อนทุกอย่าง (ลำดับคอลัมน์จริงใน DB ไม่ใช่แค่ในไฟล์นี้ — ดู 0005)
    // ชื่อไทยแยกส่วน — ทั้ง OHEM และไฟล์ HR เก็บแยกอยู่แล้ว จึงเติมได้ทุกคนโดยไม่ต้องเดา
    // ว่างได้เผื่อแหล่งข้อมูลบางรายที่ให้มาเป็นชื่อเต็มก้อนเดียว
    //
    // คอลัมน์ name (ชื่อเต็มก้อนเดียว) ถูกถอดออกใน 0005 — ข้อมูลซ้ำกับสองช่องนี้
    // ใครต้องการชื่อเต็มให้ประกอบเอาเอง อย่าเพิ่มคอลัมน์เก็บซ้ำกลับมา
    firstName: varchar({ length: 100 }),
    lastName: varchar({ length: 100 }),
    // ชื่ออังกฤษ — มาจากระบบ HR เท่านั้น (SAP ไม่มีเก็บ) จึงว่างได้และจะว่างสำหรับคนที่
    // จับคู่ชื่อไทยกับไฟล์ HR ไม่ได้ ใช้ตอนออกเอกสาร/ส่งอีเมลภาษาอังกฤษ
    // แยกสองคอลัมน์ตามที่ระบบ HR เก็บ ไม่รวบเป็นช่องเดียวเพื่อให้เรียงตามนามสกุลได้
    firstNameEn: varchar({ length: 100 }),
    lastNameEn: varchar({ length: 100 }),
    // ── รหัสที่ SAP ใช้อ้างผู้ขอบนใบสั่งซื้อ (OPOR.OwnerCode = OHEM.empID) ────────
    //
    // ★ ย้ายออกจากตารางนี้ไปแล้วตั้งแต่ 0025 — อยู่ที่ employee_company.ownerCode
    //   คอลัมน์ ownerCodeUba / ownerCodeUbp / ownerCodeMig ถูกลบทิ้งใน 0027
    //
    // เหตุผลที่ต้องแยกตามบริษัท (เก็บไว้เพราะเป็นข้อเท็จจริงที่ยังจริงอยู่): OHEM มีอยู่ทุกฐาน
    // และเดินเลขอิสระกัน — UBA เทียบ UBP เลขชนกัน 264 ตัว (99% ของฝั่ง UBP) และคนคนเดียว
    // อยู่ทั้งสองฐาน 247 คน ในนั้น 82 คนบังเอิญได้เลขเดียวกัน ซึ่งเป็นกับดัก: resolve โดย
    // ไม่ดูบริษัทจะ "ดูเหมือนถูก" 82 เคส เทสต์ผ่าน แล้วอีก 165 คนผูกผิดคนเงียบ ๆ
    // → การ์ด Teams ขออนุมัติวิ่งไปหาหัวหน้าผิดคน
    //
    // ทำไมสุดท้ายเป็นตารางเชื่อม ไม่ใช่คอลัมน์ต่อบริษัท: แพทเทิร์นคอลัมน์เริ่มเป็นภาระทันที
    // ที่บริษัทที่สามเข้ามา (เพิ่มคอลัมน์ + case + migration ทุกครั้ง) และตารางเชื่อมยังเก็บ
    // "แผนกในบริษัทนั้น" ได้ด้วย ซึ่งคอลัมน์ทำไม่ได้เลย — ดู employee_company ท้ายไฟล์
    //
    // บริษัทที่สังกัดตามระบบ HR — คนละเรื่องกับ employee_company ซึ่งบอกว่า "มีตัวตน
    // ใน OHEM ฐานไหนบ้าง" คน UBP ที่ถูกลงทะเบียนใน OHEM ของ UBA ด้วยมีอยู่จริงและเยอะ
    //
    // NULL ได้โดยตั้งใจ ไม่ใช่ "ลืมกรอก": ในไฟล์ employee.csv มี 52 คนที่ HR ไม่มีข้อมูล
    // แล้ว (ไฟล์กำกับไว้เองว่า '(ไม่มีในไฟล์ HR)') เป็นพนักงานรุ่นเก่าที่ SAP ยังมีอยู่
    // — เดาสังกัดให้พวกเขาคือการแต่งข้อมูล NULL บอกความจริงว่า "ไม่รู้"
    // ไม่มีอะไรพึ่งพาคอลัมน์นี้ ใช้แค่แสดงผลกับกรองรายงาน การ resolve ใช้ ownerCode* เท่านั้น
    companyCode: varchar({ length: 20 }),
    // รหัสพนักงานจากระบบ HR — เลขที่พนักงานรู้จักและใช้จริง คนละชุดกับ ownerCode
    // เก็บไว้แสดงผลและเชื่อมกับระบบ HR ในอนาคต ไม่ได้ใช้ในการ sync
    //
    // varchar ไม่ใช่ integer (แก้ใน 0006): เคยสมมติว่าเป็นเลข 7 หลักเสมอ แต่ข้อมูลจริงจาก HR
    // มี 14 คนที่รหัสเป็นตัวอักษรผสม (KTP1, T030, K012 — บริษัทในเครือใช้ prefix ของตัวเอง)
    // ถ้าคง integer ไว้ คนกลุ่มนั้นต้อง import แบบทิ้งรหัสพนักงานไปเลย
    empId: varchar({ length: 20 }),
    // ว่างได้ — จากข้อมูลจริงของ OHEM มีอีเมลแค่ 57 จาก 290 คน และในกลุ่มผู้ขอ PO 64 คน
    // มี 28 คนที่ไม่มีอีเมลจากแหล่งไหนเลย (พนักงานโรงงานส่วนใหญ่ไม่มีอีเมลบริษัท)
    // ถ้าบังคับ NOT NULL ต่อไป จะอิมพอร์ตคนกลุ่มนั้นไม่ได้ แล้ว ownerPrId ของ PO
    // ที่พวกเขาเป็นผู้ขอก็จะว่างตลอดไป ซึ่งขัดกับเหตุผลที่ตารางนี้มีอยู่
    // (unique ยังอยู่ได้ — pg ยอมให้ NULL ซ้ำกันหลายแถวใน unique index)
    //
    // ตั้งแต่ 0005 นี่คือ "แหล่งเดียว" ของอีเมลทั้งระบบ — ตาราง user_email ถูกถอดออก
    // user คนไหนต้องการอีเมลให้ไต่ผ่าน user.employeeId มาที่นี่
    // ⚠️ user ที่ employeeId เป็น NULL (service account) จะไม่มีอีเมลเลยโดยการออกแบบ
    email: varchar({ length: 100 }),
    // คง NOT NULL ไว้ — พนักงานทุกคนต้องอยู่สักแผนก ถ้ายอมให้ null ทุกที่ที่ join ต้อง
    // เผื่อกรณี null ตลอดไป ทั้งที่มันควรเป็นภาวะชั่วคราวระหว่างนำเข้าข้อมูล
    //
    // คนที่ยังจับคู่แผนกไม่ได้ให้ชี้ไปที่แถวพัก departmentId = '-1' ("ยังไม่ระบุแผนก")
    // ซึ่ง isActive = false จึงไม่โผล่ใน dropdown ให้ใครเลือกใหม่ได้ ต่างจากแผนก "ไม่ระบุ"
    // แบบเปิดใช้ที่จะกลายเป็นแผนกถาวร — และนับได้ว่าเหลืออีกกี่คนที่ยังไม่ได้ตามเก็บ:
    //   SELECT count(*) FROM employee e JOIN department d ON d.id = e."departmentId"
    //   WHERE d."departmentId" = '-1';
    departmentId: integer().notNull(),
    // ลาออกแล้วปิดใช้ ไม่ลบ — asset ที่เคยอยู่ในความรับผิดชอบต้องยังสาวกลับได้ว่าเป็นของใคร
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.departmentId],
      foreignColumns: [department.id],
      name: 'fk_employee_department',
    }),
    index('idx_employee_department_id').on(table.departmentId),
    unique('uq_employee_email').on(table.email),
    // รหัสพนักงานจาก HR ต้องซ้ำไม่ได้ — เป็นคีย์ธรรมชาติที่สคริปต์ import ใช้ ON CONFLICT
    // ถ้าซ้ำได้ การรันซ้ำจะเพิ่มแถวใหม่ทุกรอบแทนที่จะอัปเดตของเดิม (pg ยอมให้ NULL ซ้ำได้)
    //
    // ★ ไม่มี unique ของ ownerCode ที่นี่แล้ว — ย้ายไปเป็น uq_employee_company_owner_code
    //   บน employee_company ซึ่งเป็น (companyCode, ownerCode) คู่กัน ตรงกับความจริงว่า
    //   เลขซ้ำข้ามบริษัทได้แต่ห้ามซ้ำในบริษัทเดียวกัน
    unique('uq_employee_emp_id').on(table.empId),
    // สังกัดตาม HR — ไม่ cascade, ไม่ notNull (ดูเหตุผลที่คอลัมน์)
    foreignKey({
      columns: [table.companyCode],
      foreignColumns: [company.code],
      name: 'fk_employee_company',
    }),
    index('idx_employee_company_code').on(table.companyCode),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════
// employee_company — "คนคนนี้ ในบริษัทนี้ คือใคร อยู่แผนกไหน"  (0025)
//
// ── ปัญหาที่ตารางนี้แก้ ────────────────────────────────────────────────────
//
// เส้นทางหาผู้อนุมัติคือ  PO.ownerPrId → employee.departmentId → department.managerId
// ขั้นแรกรู้จักบริษัท (เลือกคอลัมน์ ownerCode ตามบริษัทของใบ) แต่ขั้นที่สองไม่รู้เลย —
// employee.departmentId มีได้ค่าเดียวต่อคน ขณะที่ department เป็นของบริษัท (0024)
//
// วัดจริงเมื่อ 2026-09-02: **241 จาก 288 คนที่มีตัวตนใน SAP อยู่สองบริษัท** (84%)
// และพนักงานทั้ง 394 คนผูกกับแผนกของ UBA ทั้งหมด ผลคือ PO ของ UBP/MIG ไม่ว่าใครเปิด
// ก็ไต่ไปจบที่หัวหน้าฝั่ง UBA เสมอ — การ์ดขออนุมัติวิ่งไปหาคนผิด ส่งแล้วเรียกคืนไม่ได้
//
// การย้าย employee.departmentId ให้ชี้บริษัทตัวเองแก้ได้แค่ 47 คนที่อยู่บริษัทเดียว
// อีก 241 คนไม่มีคำตอบเดียวที่ถูก จึงต้องเป็นตารางแยก ไม่ใช่การแก้ค่าในคอลัมน์เดิม
//
// ── ยุบ ownerCodeUba/Ubp/Mig มาไว้ที่นี่ด้วย ──────────────────────────────
//
// สามคอลัมน์นั้นคือแพทเทิร์น "หนึ่งคอลัมน์ต่อบริษัท" ที่เลือกไว้ตอนมี 2 บริษัท และเริ่ม
// ออกดอกเป็นภาระตอน MIG เข้ามาเป็นตัวที่สาม (ต้องเพิ่มคอลัมน์ + case + migration ทุกครั้ง)
// ที่นี่บริษัทเป็น "แถว" การเพิ่มบริษัทที่สี่จึงไม่ต้องแตะ schema อีกเลย
//
// ⚠️ คอลัมน์เดิมยังอยู่ในตาราง employee ชั่วคราวเพื่อให้ย้อนกลับได้รอบเดียว
//    **ห้ามอ่านจากคอลัมน์พวกนั้นแล้ว** อ่านจากตารางนี้ที่เดียว — จะถูกลบใน migration ถัดไป
// ═══════════════════════════════════════════════════════════════════════════
export const employeeCompany = pgTable(
  'employee_company',
  {
    employeeId: integer().notNull(),
    companyCode: varchar({ length: 20 }).notNull(),
    // OHEM.OwnerCode ของบริษัทนี้ (SAP เรียกช่องนี้ว่า empID) — ค่าที่ OPOR.OwnerCode ชี้มา
    // NULL ได้: คนที่เรารู้ว่าสังกัดบริษัทนี้ แต่ยังไม่มีตัวตนใน OHEM ของฐานนั้น
    ownerCode: integer(),
    /**
     * แผนกของคนนี้ "ในบริษัทนี้" — ตัวที่ใช้ไต่ไปหาหัวหน้าผู้อนุมัติ
     *
     * ★ NULL = "รู้ว่ามีตัวตนในบริษัทนี้ แต่ยังไม่รู้ว่าอยู่แผนกไหน" ซึ่งเป็นความจริง
     *   ไม่ใช่ข้อมูลขาด — ตอน backfill ฝั่ง UBP มี 21 คนที่ไม่มีข้อมูลแผนกมาให้
     *   ห้ามถอยไปใช้ employee.departmentId แทน นั่นคือบั๊กเดิมทั้งดุ้น
     *   ผลของ NULL คือส่งคำขอของบริษัทนั้นไม่ได้จนกว่าจะมีคนเติม (ล้มดัง ไม่ใช่ส่งผิดคน)
     */
    departmentId: integer(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.employeeId, table.companyCode], name: 'pk_employee_company' }),
    // OwnerCode ห้ามซ้ำภายในบริษัทเดียวกัน (ข้ามบริษัทซ้ำได้ — คนละฐาน เลขทับกัน 264 ตัว)
    // pg ยอมให้ NULL ซ้ำได้ จึงไม่บล็อกคนที่ยังไม่มีตัวตนใน OHEM
    unique('uq_employee_company_owner_code').on(table.companyCode, table.ownerCode),
    // ลบพนักงาน = ความสัมพันธ์กับทุกบริษัทหายตาม (แถวนี้ไม่มีความหมายถ้าไม่มีคน)
    foreignKey({
      columns: [table.employeeId],
      foreignColumns: [employee.id],
      name: 'fk_employee_company_employee',
    }).onDelete('cascade'),
    // ไม่ cascade: ลบบริษัทที่ยังมีคนผูกอยู่ไม่ได้
    foreignKey({
      columns: [table.companyCode],
      foreignColumns: [company.code],
      name: 'fk_employee_company_company',
    }),
    // ★★ หัวใจของตารางนี้ — composite FK บังคับว่าแผนกต้องเป็นของบริษัทเดียวกับแถวนี้
    //    ยัดแผนกของ UBA ลงแถว UBP ไม่ได้ DB ปฏิเสธเอง ซึ่งคือบั๊กที่ตารางนี้มาแก้พอดี
    //    (แพทเทิร์นเดียวกับ asset -> grpo_line(id, poItemId) และ attachment(id, docType))
    foreignKey({
      columns: [table.departmentId, table.companyCode],
      foreignColumns: [department.id, department.companyCode],
      name: 'fk_employee_company_department',
    }),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอน sync map OwnerCode -> employee.id ทั้งชุด
    index('idx_employee_company_owner').on(table.companyCode, table.ownerCode),
    index('idx_employee_company_department').on(table.departmentId),
  ],
);
