import { pgTable, serial, bigint, varchar } from 'drizzle-orm/pg-core';

// ตาราง bookkeeping เก่าของ TypeORM — เก็บไว้ใน schema เพื่อกัน drizzle-kit generate สั่ง DROP
// ไม่ได้ใช้ใน runtime (Drizzle ใช้ตาราง __drizzle_migrations ของตัวเอง)
export const migrations = pgTable('migrations', {
  id: serial().primaryKey().notNull(),
  timestamp: bigint({ mode: 'number' }).notNull(),
  name: varchar().notNull(),
});
