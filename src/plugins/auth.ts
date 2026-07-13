// src/config/env.ts
import { t } from 'elysia';
import { Value } from '@sinclair/typebox/value';

// 1) ประกาศ "สัญญา" ว่าแอปนี้ต้องการ env อะไรบ้าง ชนิดไหน
const EnvSchema = t.Object({
  PORT: t.Number({ default: 3000 }),
  DB_HOST: t.String(),
  DB_PORT: t.Number(),
  DB_USERNAME: t.String(),
  DB_PASSWORD: t.String(),
  DB_NAME: t.String(),
  CORS_ORIGIN: t.String({ default: 'http://localhost:5173' }),
});

// 2) Convert: ค่าใน .env เป็น string ล้วน ("3000") — แปลงเป็นชนิดจริง (3000) ตาม schema
const parsed = Value.Convert(EnvSchema, Value.Default(EnvSchema, { ...Bun.env }));

// 3) Check: ถ้าไม่ผ่าน = โยน error ทันที แอปไม่ขึ้น — นี่คือ fail fast
if (!Value.Check(EnvSchema, parsed)) {
  const details = [...Value.Errors(EnvSchema, parsed)]
    .map((e) => `  ${e.path.slice(1)}: ${e.message}`)
    .join('\n');
  throw new Error(`Environment variables ไม่ครบหรือผิดชนิด:\n${details}\n(เช็คไฟล์ .env เทียบกับ .env.example)`);
}

// 4) export ตัวเดียว — ที่อื่นห้ามแตะ Bun.env อีก
export const env: typeof EnvSchema.static = parsed;