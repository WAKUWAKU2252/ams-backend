// ═══════════════════════════════════════════════════════════════════════════
// นำเข้าห้อง (asset_sub_location) + ตึก (asset_location) จาก docs/import-sub-location.sql
//
//   bun run db:import:sub-location            → dry-run (rollback ทิ้งท้าย) ← ค่าเริ่มต้น
//   bun run db:import:sub-location --commit   → เขียนจริง
//
// ทำไมมีตัวนี้ทั้งที่มีไฟล์ .sql อยู่แล้ว: ไฟล์นั้นห่อ BEGIN/COMMIT ไว้เอง ซึ่งเชื่อถือได้
// เฉพาะตอนรัน "ทั้งไฟล์รวดเดียว" — GUI อย่าง pgAdmin/DBeaver รันเฉพาะคำสั่งที่เคอร์เซอร์
// อยู่หรือที่ไฮไลต์ไว้ได้ แล้วจะจบลงที่ COMMIT เปล่า ๆ พร้อม WARNING "there is no
// transaction in progress" โดยไม่มีอะไรถูกเขียนและไม่มี error ให้เห็น (เกิดมาแล้วรอบหนึ่ง)
// ตัวนี้ยิงทั้งไฟล์เป็นก้อนเดียวเสมอ เลยพลาดแบบนั้นไม่ได้
//
// ⚠️ ตัวไฟล์ .sql ปั๊มจาก tools/sublocation-sql.mjs — แก้ที่ไฟล์ที่ trace แล้วปั๊มใหม่
//    อย่าแก้ .sql มือ และอย่าแก้ตรรกะการนำเข้าที่นี่ ที่นี่มีหน้าที่แค่ "รันไฟล์นั้น"
// ═══════════════════════════════════════════════════════════════════════════
import type { PoolClient } from 'pg';
import { pool } from '../index';

// อ้างจากตำแหน่งไฟล์นี้ ไม่ใช่ cwd — จะได้รันจากโฟลเดอร์ไหนก็เจอไฟล์เดียวกัน
const SQL_FILE = decodeURIComponent(
  new URL('../../../../../docs/import-sub-location.sql', import.meta.url).pathname,
).replace(/^\/([A-Za-z]:)/, '$1');

const COMMIT = process.argv.includes('--commit');

type Counts = { locations: number; rooms: number; withPolygon: number };

async function counts(client: PoolClient): Promise<Counts> {
  const r = await client.query<{ locations: string; rooms: string; with_polygon: string }>(`
    SELECT (SELECT count(*) FROM asset_location WHERE code LIKE 'UBIS-%') AS locations,
           (SELECT count(*) FROM asset_sub_location) AS rooms,
           (SELECT count(*) FROM asset_sub_location WHERE polygon IS NOT NULL) AS with_polygon`);
  const row = r.rows[0];
  return { locations: +(row?.locations ?? 0), rooms: +(row?.rooms ?? 0), withPolygon: +(row?.with_polygon ?? 0) };
}

async function main() {
  const file = Bun.file(SQL_FILE);
  if (!(await file.exists())) throw new Error(`ไม่พบไฟล์ ${SQL_FILE} — ปั๊มก่อนด้วย tools/sublocation-sql.mjs`);

  // ตัด BEGIN/COMMIT ของไฟล์ออก แล้วคุมทรานแซกชันจากตรงนี้แทน — dry-run ถึงจะทำได้
  // (ถ้าปล่อยไว้ COMMIT ในไฟล์จะปิดทรานแซกชันไปก่อนที่เราจะได้ตัดสินใจ rollback)
  const body = (await file.text()).replace(/^[ \t]*(BEGIN|COMMIT)[ \t]*;[ \t]*$/gim, '');

  // ต้องเป็น client เส้นเดียวตลอด ไม่ใช่ pool.query: BEGIN กับ ROLLBACK ต้องอยู่ connection
  // เดียวกัน ไม่งั้นทรานแซกชันค้างเปิดทิ้งไว้แล้วปลดไม่ได้ (หลักเดียวกับ advisory lock ใน sync engine)
  const client = await pool.connect();
  let after: Counts;
  let before: Counts;
  try {
    // ยืนยันว่ากำลังคุยกับ DB ตัวไหนอยู่ — เครื่องนี้มี core_business (ของระบบอื่น 113 ตาราง)
    // อยู่ด้วย และ user ที่ใช้เป็น superuser ที่เขียนได้ทั้งสองฝั่ง
    const dbName = (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]?.db ?? '?';
    before = await counts(client);

    console.log(`ไฟล์      : ${SQL_FILE}`);
    console.log(`ฐานข้อมูล : ${dbName}`);
    console.log(`ก่อนรัน   : ตึก UBIS-* ${before.locations} แถว, ห้อง ${before.rooms} แถว (มีขอบเขต ${before.withPolygon})`);

    await client.query('BEGIN');
    // ห้ามรอ lock ไม่จำกัดเวลา — เคสจริงที่เจอ: มีคนเปิดไฟล์นี้ใน pgAdmin แล้วรันค้างไว้
    // โดยไม่ commit เซสชันนั้นถือ RowExclusiveLock ของสองตารางนี้อยู่ สคริปต์เลยรอเงียบ ๆ
    // ตลอดกาลโดยไม่มีอะไรพิมพ์ออกมา ตั้ง timeout ให้มันล้มพร้อมบอกสาเหตุแทน
    await client.query(`SET LOCAL lock_timeout = '10s'`);
    await client.query(`SET LOCAL statement_timeout = '300s'`);
    // ส่งเป็นสตริงเปล่า ๆ ไม่มี values — pg จะใช้ simple query protocol ซึ่งยอมให้มีหลาย
    // คำสั่งในก้อนเดียว ถ้าใส่ values หรือใช้ drizzle execute มันจะไปทาง extended protocol
    // ที่ห้าม "multiple commands into a prepared statement" แล้วล้มทั้งที่ SQL ถูก
    await client.query(body);
    after = await counts(client);
    await client.query(COMMIT ? 'COMMIT' : 'ROLLBACK');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  console.log(`หลังรัน   : ตึก UBIS-* ${after.locations} แถว, ห้อง ${after.rooms} แถว (มีขอบเขต ${after.withPolygon})`);

  if (!COMMIT) {
    console.log(`\n🔍 dry-run — rollback แล้ว ไม่มีอะไรถูกเขียนลง DB`);
    console.log(`   ตัวเลข "หลังรัน" ข้างบนคือผลที่จะได้ถ้ารันจริง`);
    console.log(`   รันจริง: bun run db:import:sub-location --commit`);
    return;
  }

  console.log(`\n✅ เขียนแล้ว — ห้อง ${before.rooms} → ${after.rooms} แถว, ตึก ${before.locations} → ${after.locations} แถว`);
  console.log(`   ตรวจต่อ: docs/check-sub-location-plan.sql (อ่านอย่างเดียว)`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('❌ import sub-location ล้มเหลว:', msg);
    if (/lock timeout|canceling statement due to lock timeout/i.test(msg)) {
      console.error('\n   รอ lock ไม่ได้ — มีเซสชันอื่นถือตารางนี้อยู่ โดยมากคือแท็บ pgAdmin');
      console.error('   ที่รัน INSERT ค้างไว้แล้วยังไม่ COMMIT/ROLLBACK  หาตัวที่ค้างด้วย:');
      console.error(`
   SELECT pid, application_name, state,
          to_char(now() - state_change, 'HH24:MI:SS') AS ค้างมานาน
   FROM pg_stat_activity
   WHERE datname = current_database() AND state LIKE 'idle in transaction%';
`);
      console.error('   แล้วกลับไปที่แท็บนั้นสั่ง ROLLBACK; (หรือปิด connection ทิ้ง) ก่อนรันใหม่');
    }
    await pool.end();
    process.exit(1);
  });
