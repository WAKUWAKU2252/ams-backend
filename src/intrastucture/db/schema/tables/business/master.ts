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
import { pgTable, serial, varchar, integer, boolean, foreignKey, index, unique, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from '@intrastucture/db/schema/shared/iso-timestamp';

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
    // รหัสแผนกจากระบบ HR ภายนอก (depCode) — ไม่ใช่ id ของตารางนี้
    // ใช้เป็นคีย์ธรรมชาติตอนนำเข้าข้อมูล ทำให้รันสคริปต์อิมพอร์ตซ้ำได้โดยไม่เกิดแถวซ้ำ
    // ซ้ำไม่ได้: ถ้าซ้ำ พนักงานจะถูกผูกเข้าแผนกผิดโดยไม่มีใครรู้
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
    unique('uq_department_hr_id').on(table.departmentId),
    // เพิ่มใน 0006 — ตารางนี้เป็น master table เดียวที่ขาดไป (category/uom/asset_location มีครบ)
    // ผลของการขาด: import ชุดใหม่ที่คีย์ธรรมชาติไม่ตรงชุดเก่าจะ insert เพิ่มทั้งชุดแทนที่จะชน
    // แล้วได้แผนกชื่อเดียวกันสองแถว ซึ่ง dropdown แยกไม่ออกและรายงานแตกเป็นสองก้อนถาวร
    // (เกือบเกิดจริงตอนสลับคีย์จาก OUDP.Code เป็นรหัส profit center)
    unique('uq_department_name').on(table.name),
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
  // และไฟล์ผังย้ายไปเป็น static asset ฝั่ง frontend (/floorplans/<code>.png) แล้ว
  // จึงไม่ต้องเก็บ path ใน DB อีก — ไม่เคยมีแถวไหนมีค่าและไม่เคยมีโค้ดอ่าน
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
    // คีย์ธรรมชาติ เช่น "HQ-F2-201" — เพิ่มใน 0007 ด้วยเหตุผลเดียวกับ asset_location.code
    // ที่นี่มีหน้าที่เพิ่มอีกอย่าง: เป็นชื่อไฟล์ผังห้องฝั่ง frontend (/floorplans/<code>.png)
    // ใช้ id แทนไม่ได้ — ห้องเดียวกันเป็น id 5 บนเครื่อง dev แต่เป็น 23 บน prod
    // แล้วหมุดตำแหน่ง asset จะไปโผล่บนผังห้องอื่นโดยไม่มีอะไรฟ้อง
    code: varchar({ length: 50 }).notNull(),
    locationId: integer().notNull(),
    // text ไม่ใช่ number: มีชั้นที่ไม่ใช่ตัวเลข เช่น B1, M
    floor: varchar({ length: 100 }),
    room: varchar({ length: 100 }),
    remark: varchar({ length: 255 }),
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
    // schema ตรงนี้เป็น plain unique เพราะ drizzle-kit push introspect NULLS NOT DISTINCT ไม่เห็น
    // (ถ้าใส่ .nullsNotDistinct() push จะ re-add ไม่จบ) — ตัวจริงที่รันบน server มี NULLS NOT DISTINCT
    // เติมมือไว้ใน migration 0000_init.sql แล้ว (Finding #4): floor/room NULL ได้ ถ้าไม่ใส่ NULLS NOT
    // DISTINCT pg จะยอม (loc,NULL,NULL) ซ้ำได้ไม่จำกัด → dev (push) ยังเป็น plain แต่ deploy ถูกต้อง
    unique('uq_asset_sub_location').on(table.locationId, table.floor, table.room),
    // ต้องไม่ซ้ำทั้งระบบ ไม่ใช่แค่ในสถานที่เดียวกัน — code ถูกใช้เป็นชื่อไฟล์ผัง
    // ซ้ำเมื่อไหร่ = สองห้องแย่งไฟล์เดียวกัน แล้วห้องหนึ่งจะเห็นผังของอีกห้อง
    unique('uq_asset_sub_location_code').on(table.code),
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
    // รหัสที่ SAP ใช้อ้างผู้ขอบนใบสั่งซื้อ (OPOR.OwnerCode = OHEM.empID)
    // ตั้งชื่อตาม SAP ตรง ๆ เพื่อให้เห็นทันทีว่าคู่กับฟิลด์ไหน — sync ใช้ตัวนี้เชื่อมอย่างเดียว
    // ว่างได้สำหรับพนักงานที่สร้างใน AMS เองและไม่มีใน SAP
    ownerCode: integer(),
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
    // ต้องซ้ำไม่ได้ทั้งคู่ — เป็นตัวจับคู่กับระบบภายนอก ถ้าซ้ำจะ resolve ได้หลายคน
    // แล้ว ownerPrId จะชี้ไปผิดคนโดยไม่มีอะไรฟ้อง (pg ยอมให้ NULL ซ้ำได้)
    unique('uq_employee_owner_code').on(table.ownerCode),
    unique('uq_employee_emp_id').on(table.empId),
    // ทางเข้าหลักของ sync: เอา OwnerCode มาหา employee.id
    index('idx_employee_owner_code').on(table.ownerCode),
  ],
);
