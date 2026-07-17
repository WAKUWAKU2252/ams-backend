import { env } from './config/env';
import { connectDb } from './db';
import { createApp } from './app';

await connectDb();
console.log(`✅ PostgreSQL connected: ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);

const app = createApp().listen(env.PORT);

console.log(`🦊 AMS API running at http://localhost:${env.PORT}`);
console.log(`📖 Swagger UI: http://localhost:${env.PORT}/swagger`);

// ═══ STEP (upload module): รอบกวาดไฟล์กำพร้า — เขียนต่อท้ายไฟล์นี้ ═══
// ไฟล์นี้คือ "runtime entry" ที่เดียวของแอป — งานที่ผูกกับเวลาจริง (job/interval)
// ต้องอยู่ที่นี่ ไม่อยู่ใน app.ts (app.ts ถูก import ใน test — ห้ามมี side effect แอบรัน)
//
// 1. import { cleanupOrphans } from './modules/upload'
//    (อย่าลืม export เพิ่มใน modules/upload/index.ts ก่อน)
// 2. ประกาศ helper เล็ก ๆ ครอบกัน job ล้มแล้วพา process ตาย:
//    const runCleanup = () =>
//      cleanupOrphans()
//        .then((n) => { if (n > 0) console.log(`🧹 กวาดไฟล์กำพร้า ${n} รายการ`) })
//        .catch(console.error)          // ห้ามปล่อย rejection หลุด
// 3. runCleanup()                        // รอบแรกทันทีตอน boot — เก็บของค้างช่วง server ปิด
// 4. setInterval(runCleanup, 60 * 60 * 1000)  // แล้วชั่วโมงละครั้ง (ขยะเน่าช้า ไม่ต้องถี่)
