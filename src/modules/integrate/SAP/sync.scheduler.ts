// ตัวตั้งเวลา — เรียก service ตัวเดียวกับที่ปุ่มเรียก ไม่มี logic ของตัวเอง
//
// ใช้ setInterval ใน process เดียวกับ API (เหมือน cleanupOrphans ที่มีอยู่เดิม)
// พอจะรันหลาย instance เมื่อไหร่ ให้ย้ายไป cron ข้างนอกยิง POST /sync แทนได้เลย —
// ทั้ง advisory lock (กันรันซ้อน) และ cooldown (กันรันถี่) อยู่ใน engine และทำงานผ่าน
// ams_db จึงคุมข้าม process ให้อยู่แล้ว ไม่ต้องมีอะไรเพิ่มฝั่ง scheduler
import { env } from '@config/env';
import { syncAll } from './sync.service';

let timer: ReturnType<typeof setInterval> | null = null;

export function startSyncScheduler(): void {
  if (env.SAP_SYNC_INTERVAL_MINUTES <= 0) {
    console.log('⏸️  SAP sync scheduler: ปิดอยู่ (SAP_SYNC_INTERVAL_MINUTES = 0)');
    return;
  }

  const run = () =>
    syncAll('SCHEDULED')
      .then((results) => {
        for (const [entity, r] of Object.entries(results)) {
          if (r.status === 'SUCCESS') {
            // log แค่ตัวเลข ไม่ log ข้อมูลที่ดึงมา — เป็นข้อมูลจัดซื้อของบริษัท
            console.log(`🔄 sync ${entity}: ${r.rowsHeader} header / ${r.rowsLine} line (${r.mode})`);
          } else if (r.status === 'FAILED') {
            console.error(`❌ sync ${entity}: ${r.error}`);
          }
        }
      })
      // syncAll เก็บ error ต่อ entity ไว้แล้ว ที่หลุดมาถึงนี่คือเรื่องนอกเหนือจากนั้น
      // ห้ามปล่อยให้ unhandled rejection ล้ม process ทั้งตัวเพราะ SAP ล่ม
      .catch((e) => console.error('❌ sync scheduler:', e));

  const intervalMs = env.SAP_SYNC_INTERVAL_MINUTES * 60 * 1000;
  timer = setInterval(run, intervalMs);
  console.log(`⏱️  SAP sync scheduler: ทุก ${env.SAP_SYNC_INTERVAL_MINUTES} นาที`);

  // ไม่รันทันทีตอนสตาร์ท — แอป restart บ่อยตอน deploy จะกลายเป็นยิง SAP รัว ๆ
  // รอบแรกให้รอครบ interval หรือกดปุ่มเอา
}

export function stopSyncScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
