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
import { isoTimestamp } from './_shared';
import { employee } from './master';

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
    // แยกชื่อ-นามสกุลออกจาก displayName — nullable เพราะบาง account (service account) หรือข้อมูลเดิม
    // ยังไม่มีค่าแยก และ displayName ยังเป็นชื่อหลักที่โชว์บน UI อยู่
    firstName: varchar({ length: 100 }),
    lastName: varchar({ length: 100 }),
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
  ],
);

// สถานะของแต่ละ email: PRIMARY = ตัวที่ใช้จริง (ส่งแจ้งเตือน/ติดต่อ) / SECONDARY = สำรอง
export const enumEmailStatus = pgEnum('email_status', ['PRIMARY', 'SECONDARY']);

// email ของ user แยกเป็นตารางเพราะ 1 user มีได้หลาย email (เมลงาน + ส่วนตัว ฯลฯ)
// user.email เดิมเก็บได้ค่าเดียว — ตารางนี้รองรับหลายอันพร้อมบอกว่าอันไหนคือตัวที่ใช้
export const userEmail = pgTable(
  'user_email',
  {
    id: serial().primaryKey().notNull(),
    userId: integer().notNull(),
    email: varchar({ length: 100 }).notNull(),
    // บอกว่า email ไหนเป็นตัวที่ใช้ (PRIMARY) — เพิ่มใหม่ default เป็น SECONDARY จนกว่าจะเลือกให้เป็นตัวหลัก
    status: enumEmailStatus().default('SECONDARY').notNull(),
    isActive: boolean().default(true).notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    // ลบ user แล้ว email ตามไปด้วย (ไม่มีความหมายถ้าไม่มีเจ้าของ)
    foreignKey({ columns: [table.userId], foreignColumns: [user.id], name: 'fk_user_email_user' }).onDelete('cascade'),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอนดึง email ทั้งหมดของ user
    index('idx_user_email_user_id').on(table.userId),
    // user เดียวกันห้ามมี email ซ้ำ
    unique('uq_user_email_user_email').on(table.userId, table.email),
    // 1 user มี PRIMARY ได้ใบเดียว — บังคับที่ DB ด้วย partial unique (กันเผลอตั้งเป็นตัวหลักสองอันพร้อมกัน)
    uniqueIndex('uq_user_email_one_primary').on(table.userId).where(sql`status = 'PRIMARY'`),
  ],
);
