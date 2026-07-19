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
import { pgTable, serial, varchar, integer, boolean, foreignKey, index, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from './_shared';

export const category = pgTable(
  'category',
  {
    id: serial().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [unique('uq_category_name').on(table.name)],
);

export const uom = pgTable(
  'uom',
  {
    id: serial().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [unique('uq_uom_name').on(table.name)],
);

export const department = pgTable(
  'department',
  {
    id: serial().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    shortName: varchar({ length: 20 }),
    // ศูนย์ต้นทุนซ้ำ = ค่าใช้จ่ายไปผูกผิดแผนก แก้ย้อนหลังยากเพราะงบถูกปิดงวดไปแล้ว
    costCenter: varchar({ length: 100 }),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [unique('uq_department_cost_center').on(table.costCenter)],
);

export const assetLocation = pgTable('asset_location', {
  id: serial().primaryKey().notNull(),
  name: varchar({ length: 100 }).notNull(),
  // ว่างได้ — ตอนเปิดสถานที่ใหม่ยังไม่มีรูปผัง ไม่ควรบล็อกการสร้างข้อมูล
  mapUrl: varchar({ length: 500 }),
  isActive: boolean().default(true).notNull(),
  createdAt: isoTimestamp().default(sql`now()`).notNull(),
  updatedAt: isoTimestamp().default(sql`now()`).notNull(),
});

export const assetSubLocation = pgTable(
  'asset_sub_location',
  {
    id: serial().primaryKey().notNull(),
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
    unique('uq_asset_sub_location').on(table.locationId, table.floor, table.room),
  ],
);

export const employee = pgTable(
  'employee',
  {
    // ไม่ใช่ serial — เป็นรหัสพนักงานที่รับมาจากระบบ HR ต้องใส่ค่าเองตอน insert
    id: integer().primaryKey().notNull(),
    name: varchar({ length: 100 }).notNull(),
    email: varchar({ length: 100 }).notNull(),
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
  ],
);
