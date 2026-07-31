import { env } from './config/env';
import { connectDb } from './db';
import { createApp } from './app';
import { cleanupOrphans } from './modules/upload';

await connectDb();
console.log(`✅ PostgreSQL connected: ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);

const app = createApp().listen(env.PORT);

console.log(`🦊 AMS API running at http://localhost:${env.PORT}`);
console.log(`📖 Swagger UI: http://localhost:${env.PORT}/swagger`);

// รอบกวาดไฟล์กำพร้า — อยู่ที่ไฟล์นี้เพราะเป็น runtime entry ที่เดียวของแอป
// (app.ts ถูก import ใน test ห้ามมี side effect อย่าง setInterval แอบรัน)
const runCleanup = () =>
  cleanupOrphans()
    .then((n) => {
      if (n > 0) console.log(`🧹 กวาดไฟล์กำพร้า ${n} รายการ`);
    })
    .catch(console.error); // ห้ามปล่อย rejection หลุดจนพา process ตาย

runCleanup(); // รอบแรกทันทีตอน boot — เก็บของค้างช่วง server ปิด
setInterval(runCleanup, 60 * 60 * 1000); // แล้วชั่วโมงละครั้ง (ขยะเน่าช้า ไม่ต้องถี่)

