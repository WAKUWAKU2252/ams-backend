// ═══════════════════════════════════════════════════════════════════════════
// นำเข้า asset_location จาก docs/asset-location-sap.csv
//
//   bun run db:import:location            → dry-run (ไม่แตะ DB) ← ค่าเริ่มต้น
//   bun run db:import:location --commit   → เขียนจริง
//
// ที่มาของข้อมูล:
//   name = OLCT.Location (SAP)  ← 52 ค่าที่ OITM.Location ของกลุ่ม 117 ชี้ถึง
//   code = ตัวย่อที่ AMS ตั้งเอง — SAP ไม่มีรหัสสั้นให้ ใช้ OLCT.Code (1..52) แทนไม่ได้
//          เพราะเป็นเลขลอย ๆ ที่คนอ่านไม่ออก
//          (0022: code ไม่ได้เป็นชื่อไฟล์ผังแล้ว ชื่อไฟล์ย้ายไป asset_sub_location.planKey
//           เพราะผังหนึ่งใบครอบทั้งชั้นของทั้งไซต์ ไม่ได้แบ่งตาม location)
//
// ⚠️ ข้อมูลชุดนี้ปนกันหลายแกน (แผนก/ห้อง/ไซต์) ตามที่ SAP ใช้จริง — เป็นการตัดสินใจ
//    ของทีมว่าจะยกมาทั้งชุด ไม่ใช่ความบังเอิญ ถ้าจะจัดระเบียบทีหลังให้ปิด isActive
//    ของแถวที่ไม่ใช้ ห้ามลบ (asset ที่ชี้อยู่จะพัง — FK กันไว้)
//
// รันซ้ำได้: ยึด code เป็นคีย์ธรรมชาติ (uq_asset_location_code) ชนแล้วอัปเดตชื่อ
// ไม่แตะ isActive ตอนอัปเดต — ช่องนั้นคนแก้เองในระบบ ถ้าเขียนทับทุกครั้งที่ import
// สถานที่ที่เพิ่งปิดไปจะกลับมาเปิดเองโดยไม่มีใครรู้ (เหตุผลเดียวกับ department.ts)
// ═══════════════════════════════════════════════════════════════════════════
import { sql } from 'drizzle-orm';
import { db, pool } from '../index';
import { assetLocation } from '../schema';
import { readCsv, toBool } from './csv';

// อ้างจากตำแหน่งไฟล์นี้ ไม่ใช่ cwd — จะได้รันจากโฟลเดอร์ไหนก็เจอไฟล์เดียวกัน
const CSV = decodeURIComponent(
  new URL('../../../../../docs/asset-location-sap.csv', import.meta.url).pathname,
).replace(/^\/([A-Za-z]:)/, '$1');

const COMMIT = process.argv.includes('--commit');

type Row = { code: string; name: string; isActive: boolean };

function load(raw: Record<string, string>[]): Row[] {
  const rows: Row[] = [];
  const seenCode = new Map<string, number>();
  const seenName = new Map<string, number>();

  raw.forEach((r, i) => {
    const line = i + 2; // +1 ข้ามหัวคอลัมน์ +1 ให้เลขตรงกับที่เห็นในโปรแกรมแก้ไฟล์
    const code = (r.code ?? '').trim();
    const name = (r.name ?? '').trim();

    if (code === '') throw new Error(`บรรทัด ${line}: code ว่าง — เป็นคีย์ที่ใช้ import ซ้ำ ปล่อยว่างไม่ได้`);
    if (name === '') throw new Error(`บรรทัด ${line}: name ว่าง (code=${code})`);
    if (code.length > 50) throw new Error(`บรรทัด ${line}: code "${code}" ยาว ${code.length} เกิน varchar(50)`);
    if (name.length > 100) throw new Error(`บรรทัด ${line}: name ยาว ${name.length} เกิน varchar(100)`);

    // code จะกลายเป็นชื่อไฟล์ผังห้องและส่วนหนึ่งของ URL — กันอักขระที่ต้อง encode
    // หรือที่ระบบไฟล์บางตัวรับไม่ได้ ตั้งแต่ตอน import ไม่ใช่ตอนหารูปไม่เจอ
    if (!/^[A-Za-z0-9-]+$/.test(code)) {
      throw new Error(`บรรทัด ${line}: code "${code}" ใช้ได้เฉพาะ A-Z a-z 0-9 และ - (จะถูกใช้เป็นชื่อไฟล์ผัง)`);
    }

    // ซ้ำในไฟล์เอง DB จับไม่ได้ตอน insert เพราะ ON CONFLICT กลืนให้เงียบ ๆ
    // แล้วเราจะได้ 51 แถวโดยไม่รู้ว่าหายไปไหน — ดักที่นี่ให้ล้มพร้อมบอกบรรทัด
    const dupCode = seenCode.get(code);
    if (dupCode) throw new Error(`บรรทัด ${line}: code "${code}" ซ้ำกับบรรทัด ${dupCode}`);
    seenCode.set(code, line);

    // name มี unique ที่ DB ด้วย (uq_asset_location_name) — ซ้ำแล้วจะล้มกลางทรานแซกชัน
    // ด้วย error ของ pg ที่ไม่บอกว่าบรรทัดไหน หาต้นเหตุในไฟล์ 52 บรรทัดยาก
    const dupName = seenName.get(name);
    if (dupName) throw new Error(`บรรทัด ${line}: name "${name}" ซ้ำกับบรรทัด ${dupName}`);
    seenName.set(name, line);

    rows.push({ code, name, isActive: toBool(r.isActive ?? '', true) });
  });

  return rows;
}

async function countLocations(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM asset_location`);
  return res.rows[0]?.n ?? 0;
}

async function main() {
  const rows = load(await readCsv(CSV));

  // ยืนยันว่ากำลังคุยกับ DB ตัวไหนอยู่ — เครื่องนี้มี core_business (ของระบบอื่น 113 ตาราง)
  // อยู่ด้วย และ user ที่ใช้เป็น superuser ที่เขียนได้ทั้งสองฝั่ง
  const dbName = (await db.execute<{ db: string }>(sql`SELECT current_database() AS db`)).rows[0]?.db ?? '?';
  const before = await countLocations();

  console.log(`ไฟล์      : ${CSV}`);
  console.log(`ฐานข้อมูล : ${dbName} (มี asset_location อยู่แล้ว ${before} แถว)`);
  console.log(`อ่านได้   : ${rows.length} แถว`);
  console.table(rows.slice(0, 5));

  if (!COMMIT) {
    console.log(`\n🔍 dry-run — ยังไม่เขียนอะไรลง DB`);
    console.log(`   จะ insert/update ${rows.length} แถว (ยึด code เป็นคีย์)`);
    console.log(`   รันจริง: bun run db:import:location --commit`);
    return;
  }

  // ทีเดียวจบในทรานแซกชันเดียว — พังกลางทางแล้วต้องไม่เหลือสถานที่ครึ่ง ๆ กลาง ๆ
  // ให้คนไปเลือกใน dropdown แล้วผูก asset เข้ากับชุดข้อมูลที่ยังไม่สมบูรณ์
  await db.transaction(async (tx) => {
    await tx
      .insert(assetLocation)
      .values(rows)
      .onConflictDoUpdate({
        target: assetLocation.code,
        set: { name: sql`excluded.name`, updatedAt: sql`now()` },
      });
  });

  const after = await countLocations();
  console.log(`\n✅ เขียนแล้ว — asset_location: ${before} → ${after} แถว (เพิ่ม ${after - before}, อัปเดต ${rows.length - (after - before)})`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('❌ import location ล้มเหลว:', e instanceof Error ? e.message : e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
