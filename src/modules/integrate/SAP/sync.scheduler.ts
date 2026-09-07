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
        // ผลเป็นสองชั้นตั้งแต่ 0021: บริษัท -> entity
        for (const [companyCode, byEntity] of Object.entries(results)) {
          for (const [entity, r] of Object.entries(byEntity)) {
            const tag = `${entity}:${companyCode}`;
            if (r.status === 'SUCCESS') {
              // log แค่ตัวเลข ไม่ log ข้อมูลที่ดึงมา — เป็นข้อมูลจัดซื้อของบริษัท
              console.log(`🔄 sync ${tag}: ${r.rowsHeader} header / ${r.rowsLine} line (${r.mode})`);
            } else if (r.status === 'FAILED') {
              console.error(`❌ sync ${tag}: ${r.error}`);
            } else {
              // ── รอบที่ถูกข้าม: ไม่ใช่ error แต่แปลว่า tick นี้ไม่ได้ทำอะไรเลย
              //
              // เดิมเงียบสนิท เวลา sync ไม่คืบแล้วมาไล่ดู log จึงเดาไม่ออกว่าเกิดอะไรขึ้น —
              // เห็นแค่ว่าไม่มีบรรทัดของ entity นั้น ซึ่งหน้าตาเหมือน "scheduler ไม่ทำงาน"
              //
              // ★ ไม่ใช่ของที่จะท่วม log: cooldown (30 วิ) สั้นกว่า interval มาก ทางที่เหลือคือ
              //   "รอบก่อนยังไม่จบ" กับ "มีอีกรอบเขียน state ไปแล้ว" ซึ่งทั้งคู่ควรเห็นจริง ๆ
              //
              // ★ ไม่แตะทางปุ่ม — syncOne/syncAllForCompany คืน SKIPPED เป็น response อยู่แล้ว
              //   คนกดเห็นเหตุผลเต็ม มีแต่ทาง scheduler ที่ไม่มีใครรับผลไปแสดง
              console.warn(`⏭️  sync ${tag}: ${r.reason}`);
            }
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
