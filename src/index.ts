import { env } from './config/env';
import { connectDb, pool } from './intrastucture/db';
import { closeSap } from './intrastucture/sap/client';
import { createApp } from './app';
import { startUploadCleanupScheduler, stopUploadCleanupScheduler } from './modules/shared/upload';
import { startSyncScheduler, stopSyncScheduler } from './modules/integrate/SAP';

await connectDb();
console.log(`✅ PostgreSQL connected: ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);

const app = createApp().listen(env.PORT);

console.log(`🦊 AMS API running at http://localhost:${env.PORT}`);
console.log(`📖 Swagger UI: http://localhost:${env.PORT}/swagger`);

// กวาดไฟล์ที่อัปแล้วไม่มีใครใช้ (ผู้ใช้ปิดฟอร์มก่อนบันทึก / ถอดรูปออกจาก asset)
startUploadCleanupScheduler();

// ดึงข้อมูลจาก SAP ตามรอบ — ไม่ต่อ SAP ตอนนี้ (pool เป็น lazy) SAP ล่มก็สตาร์ทได้ปกติ
startSyncScheduler();

// ═══════════════════════════════════════════════════════════════════════════
// ปิดแอปอย่างสุภาพ
//
// Dockerfile ใช้ exec form → bun เป็น PID 1 และรับ SIGTERM ตรง ๆ ตอน docker stop /
// deploy ใหม่ ถ้าไม่มี handler bun จะตายทันที ซึ่งเสียสองอย่าง:
//
//   1) รอบ sync ที่กำลังทำงานอยู่จะถูกตัดกลางคันโดย **ไม่มีแถว FAILED บันทึกไว้**
//      (logFailure ไม่ได้ทำงาน) ประวัติจะเงียบเหมือนรอบนั้นไม่เคยเกิด แล้วเวลามีคนถาม
//      ว่า "sync หายไปตอนไหน" จะไม่มีอะไรให้ดู
//   2) pool ของ mssql/pg ไม่ถูกปิด — ฝั่ง SAP เป็น DB จริงของบริษัทที่คนอื่นใช้ร่วม
//      การทิ้ง connection ค้างไว้ให้ TCP timeout เก็บกวาดเองไม่ใช่มารยาทที่ดี
//
// ── ข้อมูลไม่เสียหายอยู่แล้วแม้ไม่มีไฟล์นี้
// ทรานแซกชันที่ค้างถูก rollback โดย pg เอง และ advisory lock หลุดตอน connection ขาด
// (ดู sync.engine.ts) ตัวนี้จึงเป็นเรื่อง "ปิดให้เรียบร้อยและบันทึกไว้" ไม่ใช่กันข้อมูลพัง
//
// ── ลำดับสำคัญ: หยุดรับงานใหม่ก่อน แล้วค่อยปิดท่อ
// ถ้าปิด pool ก่อนหยุด timer รอบ sync ที่เพิ่งเริ่มจะพังกลางคันด้วย error ที่ไม่ใช่สาเหตุจริง
// ═══════════════════════════════════════════════════════════════════════════

/** เผื่อ orchestrator ยิงซ้ำ หรือ SIGINT ตามด้วย SIGTERM — ปิดรอบเดียวพอ */
let shuttingDown = false;

/**
 * เพดานเวลารอ — pool.end() ของ pg รอจนกว่า client ที่ถูกยืมไปจะถูกคืนครบ ซึ่งแปลว่า
 * รอบ sync ที่กำลังเขียนอยู่จะกลายเป็นตัวกำหนดว่าเราปิดได้เมื่อไหร่ (ยาวได้ถึงหลักนาที)
 *
 * docker/k8s ให้เวลาราว 10 วิก่อนยิง SIGKILL ตามมาอยู่แล้ว รอเกินกว่านั้นจึงไม่มีประโยชน์
 * — ยอมโดนตัดแบบเดิมดีกว่าค้างจนถูกฆ่าโดยไม่ได้ log อะไรเลย
 */
const SHUTDOWN_TIMEOUT_MS = 8_000;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 ได้รับ ${signal} — กำลังปิดแอป`);

  // 1) หยุด job ตามรอบก่อน ไม่ให้มีรอบใหม่เกิดระหว่างที่กำลังปิดท่อ
  stopSyncScheduler();
  stopUploadCleanupScheduler();

  try {
    // 2) หยุดรับ request ใหม่ (request ที่ค้างอยู่ปล่อยให้จบเอง — ไม่ส่ง true)
    await app.stop();

    // 3) ปิด pool ทั้งสองฝั่ง ขนานกันได้ ไม่เกี่ยวกันเลย
    //    ครอบด้วย timeout เพราะ pool.end() รอ client ที่ยังถูกยืมอยู่ (ดูหมายเหตุข้างบน)
    await Promise.race([
      Promise.all([closeSap(), pool.end()]),
      new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
    ]);

    console.log('👋 ปิดเรียบร้อย');
  } catch (e) {
    // ปิดไม่สำเร็จก็ยังต้องออกอยู่ดี — log ไว้ให้รู้ว่าปิดแบบไม่สะอาด
    console.error('❌ ปิดแอปไม่เรียบร้อย:', e);
  }

  // ออกเองแทนการรอ event loop ว่าง: timer ที่ยังไม่ถูกล้าง / socket ที่ค้าง จะทำให้
  // process ไม่ยอมตายแล้วโดน SIGKILL ตามมาแทน ซึ่งกลบผลของการปิดสุภาพทั้งหมด
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
