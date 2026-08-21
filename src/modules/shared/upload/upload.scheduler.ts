// ตัวตั้งเวลากวาดไฟล์กำพร้า — เรียก service ตัวเดียวกับที่อื่นเรียก ไม่มี logic ของตัวเอง
// (โครงเดียวกับ SAP sync.scheduler.ts — ถ้าจะรันหลาย instance ให้ย้ายไป cron ข้างนอก)
//
// เดิมโค้ดนี้อยู่ใน src/index.ts ตรง ๆ ย้ายมาที่นี่เพราะ:
//   1. index.ts ควรเป็นแค่ลำดับการสตาร์ท ไม่ใช่ที่เก็บ logic ของ module
//   2. ปิดไม่ได้ — เครื่อง dev ที่แชร์ DB กันจะกวาดไฟล์ของกันและกันโดยไม่มีทางหยุด
//   3. เดิมยิงทันทีตอนสตาร์ท ซึ่งตอน deploy ที่ restart ติด ๆ กันจะรันซ้ำหลายรอบ
import { env } from '@config/env';
import { cleanupOrphans } from './upload.service';

let timer: ReturnType<typeof setInterval> | null = null;

export function startUploadCleanupScheduler(): void {
  if (env.UPLOAD_CLEANUP_INTERVAL_MINUTES <= 0) {
    console.log('⏸️  upload cleanup: ปิดอยู่ (UPLOAD_CLEANUP_INTERVAL_MINUTES = 0)');
    return;
  }

  const run = () =>
    cleanupOrphans()
      .then((n) => {
        // เงียบเมื่อไม่มีอะไรให้กวาด — log ทุกชั่วโมงว่า "ลบ 0 ไฟล์" คือ noise ที่กลบของจริง
        if (n > 0) console.log(`🧹 upload cleanup: ลบไฟล์กำพร้า ${n} ไฟล์`);
      })
      // ห้ามปล่อยให้ unhandled rejection ล้ม process — DB สะดุดตอนกวาดไม่ควรทำ API ตาย
      // และรอบหน้าก็กวาดต่อได้เอง (ไฟล์ไม่ได้หายไปไหน)
      .catch((e) => console.error('❌ upload cleanup:', e));

  timer = setInterval(run, env.UPLOAD_CLEANUP_INTERVAL_MINUTES * 60 * 1000);
  console.log(`⏱️  upload cleanup: ทุก ${env.UPLOAD_CLEANUP_INTERVAL_MINUTES} นาที`);

  // ไม่รันทันทีตอนสตาร์ท (ต่างจากโค้ดเดิม) — เกณฑ์กำพร้าคือ "เก่ากว่า 24 ชม." อยู่แล้ว
  // ไม่มีอะไรเร่งด่วนพอจะต้องกวาดวินาทีแรก และ restart ถี่ ๆ ตอน deploy จะรันซ้ำเปล่า ๆ
}

export function stopUploadCleanupScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
