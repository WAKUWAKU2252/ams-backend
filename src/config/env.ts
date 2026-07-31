import { t } from 'elysia';
import { Value } from '@sinclair/typebox/value';

// สัญญาของแอป: ต้องมี env ครบตามนี้ ไม่ครบ = ไม่ยอมสตาร์ท (fail fast)
const EnvSchema = t.Object({
  PORT: t.Number({ default: 3000 }),
  DB_HOST: t.String(),
  DB_PORT: t.Number(),
  DB_USERNAME: t.String(),
  DB_PASSWORD: t.String(),
  DB_NAME: t.String(),
  DB_SSL: t.Boolean({ default: false }),
  CORS_ORIGIN: t.String({ default: 'http://localhost:5173' }),
  UPLOAD_DIR: t.String({ default: './uploads' }),
  JWT_SECRET: t.String({ minLength: 16 }),
  JWT_EXPIRES_IN: t.String({ default: '8h' }),
});

// ค่าใน .env เป็น string ล้วน — Convert แปลงเป็นชนิดจริงตาม schema ("3000" -> 3000)
const parsed = Value.Convert(EnvSchema, Value.Default(EnvSchema, { ...Bun.env }));

if (!Value.Check(EnvSchema, parsed)) {
  const details = [...Value.Errors(EnvSchema, parsed)]
    .map((e) => `  ${e.path.slice(1)}: ${e.message}`)
    .join('\n');
  throw new Error(
    `Environment variables ไม่ครบหรือผิดชนิด:\n${details}\n(เช็คไฟล์ .env เทียบกับ .env.example)`,
  );
}

// จุดเดียวที่แตะ Bun.env — ไฟล์อื่นให้ import { env } จากที่นี่เท่านั้น
export const env: typeof EnvSchema.static = parsed;
