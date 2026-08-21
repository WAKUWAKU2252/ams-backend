import { env } from './config/env';
import { connectDb } from './intrastucture/db';
import { createApp } from './app';
import { startUploadCleanupScheduler } from './modules/shared/upload';
import { startSyncScheduler } from './modules/integrate/SAP';

await connectDb();
console.log(`✅ PostgreSQL connected: ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);

const app = createApp().listen(env.PORT);

console.log(`🦊 AMS API running at http://localhost:${env.PORT}`);
console.log(`📖 Swagger UI: http://localhost:${env.PORT}/swagger`);

// กวาดไฟล์ที่อัปแล้วไม่มีใครใช้ (ผู้ใช้ปิดฟอร์มก่อนบันทึก / ถอดรูปออกจาก asset)
startUploadCleanupScheduler();

// ดึงข้อมูลจาก SAP ตามรอบ — ไม่ต่อ SAP ตอนนี้ (pool เป็น lazy) SAP ล่มก็สตาร์ทได้ปกติ
startSyncScheduler();

