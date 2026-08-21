// ═══════════════════════════════════════════════════════════════════════════
// user / role — บัญชี login และสิทธิ์ (ตรงกับ Masterdata.xlsx sheet User / Role)
//
// stage ปัจจุบัน: mock user เก็บ password hash เอง (Bun.password = argon2id)
// ยังไม่ทำ JWT — login แค่ verify แล้วคืน user+role, token ค่อยเสียบทีหลัง
//
// ผูกกับ employee (master จาก HR): user = บัญชีเข้าระบบ, employee = ตัวตนผู้ถือครอง
// asset — "asset ของฉัน" = asset.employeeId เท่ากับ user.employeeId
// ═══════════════════════════════════════════════════════════════════════════
import { pgTable, pgEnum, serial, integer, varchar, boolean, foreignKey, index, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from './shared/iso-timestamp';
import { employee } from './tables/business/master';

export const role = pgTable(
  'role',
  {
    id: serial().primaryKey().notNull(),
    // EMPLOYEE / MANAGER / FINANCE — ชื่อห้ามซ้ำ (ใช้อ้างสิทธิ์ในโค้ด)
    name: varchar({ length: 50 }).notNull(),
    description: varchar({ length: 255 }),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [unique('uq_role_name').on(table.name)],
);

export const user = pgTable(
  // reserved word ใน SQL — drizzle ใส่ quote ("user") ให้เองในทุก query
  'user',
  {
    id: serial().primaryKey().notNull(),
    username: varchar({ length: 100 }).notNull(),
    // email ย้ายไปตาราง user_email แล้ว (1 user หลาย email) — ดึงตัวหลักจาก userEmail ที่ status=PRIMARY
    displayName: varchar({ length: 100 }).notNull(),
    // ไม่มี firstName/lastName ที่นี่แล้ว — ชื่อ-นามสกุลเป็นของ employee ซึ่งรับมาจาก
    // SAP/HR ที่เราไม่ได้เป็นคนตั้ง ถ้าเก็บสองที่จะแก้ที่หนึ่งแล้วอีกที่ไม่ตามโดยไม่มีใครรู้
    // displayName ยังอยู่เพราะเป็นชื่อที่ผู้ใช้ตั้งเองได้ ไม่ผูกกับข้อมูล HR
    // เก็บเฉพาะ hash (argon2id จาก Bun.password) ไม่เคยเก็บ plaintext / ห้าม return ออก API
    // nullable — รองรับ user ที่ยืนยันผ่าน AD ในอนาคต (ฝั่งเราไม่มี hash)
    passwordHash: varchar({ length: 255 }),
    roleId: integer().notNull(),
    // ว่างได้ — บาง account อาจไม่ผูกกับพนักงานในระบบ HR (เช่น service account)
    employeeId: integer(),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
    deletedAt: isoTimestamp(),
  },
  (table) => [
    foreignKey({ columns: [table.roleId], foreignColumns: [role.id], name: 'fk_user_role' }),
    foreignKey({ columns: [table.employeeId], foreignColumns: [employee.id], name: 'fk_user_employee' }),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอน join role/employee และกรองตามสิทธิ์
    index('idx_user_role_id').on(table.roleId),
    index('idx_user_employee_id').on(table.employeeId),
    // username ใช้ระบุตัวตนตอน login — ห้ามซ้ำทั้งระบบ
    unique('uq_user_username').on(table.username),
    // 1 พนักงาน = 1 account — ถ้าซ้ำได้ "asset ของฉัน" จะกำกวมทันที เพราะสอง account
    // จะเห็น asset ชุดเดียวกัน และไม่มีทางรู้ว่าใครเป็นผู้ถือครองจริง
    // (pg ยอมให้ NULL ซ้ำได้ จึงยังรองรับ service account ที่ไม่ผูกพนักงาน)
    unique('uq_user_employee').on(table.employeeId),
  ],
);

// ── ตาราง user_email ถูกถอดออกใน 0005 ──────────────────────────────────────
// เหตุผล: อีเมลเคยอยู่สองที่ (employee.email จาก HR/SAP + user_email ที่ AMS ตั้งเอง)
// ซึ่งไม่มีกติกาบอกว่าอันไหนจริงกว่ากันเมื่อสองอันไม่ตรง — ตอนนี้เหลือแหล่งเดียวคือ
// employee.email ไต่ไปจาก user.employeeId
//
// ⚠️ ผลที่ตามมาโดยตั้งใจ:
//   - user ที่ employeeId = NULL (service account) ไม่มีอีเมล
//   - 1 user มีได้อีเมลเดียว (ของเดิมรองรับหลายอัน + PRIMARY/SECONDARY)
//   - แก้อีเมลต้องไปแก้ที่ employee ซึ่งเป็นข้อมูลจาก HR ไม่ใช่ของที่ AMS เป็นเจ้าของ
// ถ้าวันหลังต้องการหลายอีเมลต่อคนอีก ให้กลับมาทำที่ employee ไม่ใช่สร้าง user_email ใหม่
