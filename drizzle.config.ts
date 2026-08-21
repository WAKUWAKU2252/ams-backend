import { defineConfig } from 'drizzle-kit';

// drizzle-kit เป็น tooling แยกจาก runtime ของ Bun — ใช้ process.env (kit โหลด .env ให้เอง)
export default defineConfig({
  dialect: 'postgresql',
  // ต้องชี้ตรงกับที่ schema/migrations อยู่จริง — ถ้า path ผิด drizzle-kit จะมองไม่เห็น
  // ตารางไหนเลย แล้ว push จะ generate DROP ให้ทุกตารางใน ams_db
  schema: './src/intrastucture/db/schema',
  out: './src/intrastucture/db/migrations',
  dbCredentials: {
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5433),
    user: process.env.DB_USERNAME ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'ams_db',
    // local ไม่ตั้ง = false เหมือนเดิม / server จริงตั้ง DB_SSL=true
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : false,
  },
});
