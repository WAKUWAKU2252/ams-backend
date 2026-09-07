// ═══════════════════════════════════════════════════════════════════════════
// นำเข้า department จาก docs/<ไฟล์>.csv — ทีละบริษัท
//
//   bun run db:import:department            → dry-run ของ UBA (ไม่แตะ DB) ← ค่าเริ่มต้น
//   bun run db:import:department --commit   → เขียนจริง
//   bun run db:import:department --company=MIG --file=department-mig.csv [--commit]
//
// ★ ต้องระบุบริษัทเสมอตั้งแต่ 0024 — departmentId เป็นผังของแต่ละบริษัท ไม่ใช่เลขที่
//   ไม่ซ้ำกันทั้งเครือ (MIG ชนกับ UBA 32 จาก 33 รหัส) คีย์ธรรมชาติจึงเป็น
//   (companyCode, departmentId) และสคริปต์นี้เขียนได้ทีละบริษัทเท่านั้น
//   — ค่าเริ่มต้นเป็น UBA เพื่อให้คำสั่งเดิมที่คนพิมพ์อยู่ยังทำสิ่งเดิมเป๊ะ
//
// ที่มาของข้อมูล:
//   departmentId = OUDP.Code (SAP)  ← คีย์ที่ OHEM.dept ชี้มา ใช้ผูก employee รอบถัดไป
//   name         = OPRC.PrcName     ← OUDP.Name เก็บแค่รหัส profit center ไม่ใช่ชื่อ
//   shortName    = ตัวย่อที่ตั้งจากชื่อ SAP (ไม่ซ้ำกันทั้ง 57 แถว)
//
// รันซ้ำได้: ยึด departmentId เป็นคีย์ธรรมชาติ (uq_department_hr_id) ชนแล้วอัปเดตชื่อ
// ไม่แตะ isActive และ managerId ตอนอัปเดต — สองช่องนั้นคนแก้เองในระบบ ถ้าเขียนทับทุกครั้ง
// ที่ SAP ส่งไฟล์ใหม่ แผนกที่เพิ่งปิดไปจะกลับมาเปิดเองโดยไม่มีใครรู้
// ═══════════════════════════════════════════════════════════════════════════
import { sql } from 'drizzle-orm';
import { db, pool } from '../index';
import { department } from '../schema';
import { readCsv, toBool } from './csv';

// อ้างจากตำแหน่งไฟล์นี้ ไม่ใช่ cwd — จะได้รันจากโฟลเดอร์ไหนก็เจอไฟล์เดียวกัน
// decodeURIComponent: pathname เป็น URL-encoded ถ้าพาธมีช่องว่างจะได้ %20 แล้วเปิดไฟล์ไม่เจอ
// replace: Windows ได้ "/C:/..." นำหน้าด้วย slash ซึ่ง Bun.file เปิดไม่ได้
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

/** บริษัทเจ้าของแถวที่จะเขียนรอบนี้ — ไฟล์หนึ่งใบ = บริษัทเดียว */
const COMPANY = (arg('company') ?? 'UBA').toUpperCase();
const CSV_NAME = arg('file') ?? 'department-sap.csv';

const CSV = decodeURIComponent(
  new URL(`../../../../../docs/${CSV_NAME}`, import.meta.url).pathname,
).replace(/^\/([A-Za-z]:)/, '$1');

const COMMIT = process.argv.includes('--commit');

type Row = { name: string; shortName: string | null; departmentId: string; isActive: boolean };

function load(raw: Record<string, string>[]): Row[] {
  const rows: Row[] = [];
  const seen = new Map<string, number>();

  raw.forEach((r, i) => {
    const line = i + 2; // +1 ข้ามหัวคอลัมน์ +1 ให้เลขตรงกับที่เห็นในโปรแกรมแก้ไฟล์
    const departmentId = r.departmentId ?? '';
    const name = r.name ?? '';

    if (departmentId === '') throw new Error(`บรรทัด ${line}: departmentId ว่าง — เป็นคีย์ที่ใช้ผูก employee ปล่อยว่างไม่ได้`);
    if (name === '') throw new Error(`บรรทัด ${line}: name ว่าง (departmentId=${departmentId})`);
    if (name.length > 100) throw new Error(`บรรทัด ${line}: name ยาว ${name.length} เกิน varchar(100)`);

    const shortName = (r.shortName ?? '').trim();
    if (shortName.length > 20) throw new Error(`บรรทัด ${line}: shortName "${shortName}" ยาว ${shortName.length} เกิน varchar(20)`);

    // ซ้ำในไฟล์เอง DB จับไม่ได้ตอน insert เพราะ ON CONFLICT จะกลืนให้เงียบ ๆ
    // แล้วเราจะได้ 56 แถวโดยไม่รู้ว่าหายไปไหน — ดักที่นี่ให้ล้มพร้อมบอกบรรทัด
    const dup = seen.get(departmentId);
    if (dup) throw new Error(`บรรทัด ${line}: departmentId "${departmentId}" ซ้ำกับบรรทัด ${dup}`);
    seen.set(departmentId, line);

    rows.push({ departmentId, name, shortName: shortName || null, isActive: toBool(r.isActive ?? '', true) });
  });

  return rows;
}

/** นับเฉพาะของบริษัทที่กำลังนำเข้า — ตัวเลขรวมทั้งตารางอ่านแล้วบอกไม่ได้ว่ารอบนี้ทำอะไร */
async function countDepartments(): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM department WHERE "companyCode" = ${COMPANY}`,
  );
  return res.rows[0]?.n ?? 0;
}

/** บริษัทต้องมีอยู่จริงก่อน — FK จะจับให้อยู่แล้ว แต่ error ของ pg อ่านไม่รู้เรื่องว่าพิมพ์รหัสผิด */
async function assertCompanyExists(): Promise<void> {
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM company WHERE code = ${COMPANY}`,
  );
  if (!res.rows[0]?.n) {
    throw new Error(
      `ไม่มีบริษัทรหัส '${COMPANY}' ในตาราง company — เพิ่มแถวบริษัทก่อน แล้วค่อยนำเข้าแผนก`,
    );
  }
}

async function main() {
  const rows = load(await readCsv(CSV));

  // shortName ไม่มี unique constraint ใน DB — ถ้าซ้ำจะ insert ผ่านแล้วไปโผล่เป็นสอง
  // ตัวเลือกหน้าตาเหมือนกันใน dropdown เตือนแต่ไม่ล้ม (บางที่อาจตั้งใจให้ซ้ำ)
  const shortNames = rows.map((r) => r.shortName).filter((s): s is string => s !== null);
  const dupShort = [...new Set(shortNames.filter((s, i) => shortNames.indexOf(s) !== i))];
  if (dupShort.length) console.warn(`⚠️  shortName ซ้ำ: ${dupShort.join(', ')}`);
  const noShort = rows.filter((r) => r.shortName === null).length;
  if (noShort) console.warn(`⚠️  shortName ว่าง ${noShort} แถว`);

  // ยืนยันว่ากำลังคุยกับ DB ตัวไหนอยู่ — เครื่องนี้มี core_business (ของระบบอื่น 113 ตาราง)
  // อยู่ด้วย และ user ที่ใช้เป็น superuser ที่เขียนได้ทั้งสองฝั่ง
  const dbName = (await db.execute<{ db: string }>(sql`SELECT current_database() AS db`)).rows[0]?.db ?? '?';
  await assertCompanyExists();
  const before = await countDepartments();

  console.log(`ไฟล์      : ${CSV}`);
  console.log(`บริษัท    : ${COMPANY}`);
  console.log(`ฐานข้อมูล : ${dbName} (มี department ของ ${COMPANY} อยู่แล้ว ${before} แถว)`);
  console.log(`อ่านได้   : ${rows.length} แถว`);
  console.table(rows.slice(0, 5));

  if (!COMMIT) {
    console.log(`\n🔍 dry-run — ยังไม่เขียนอะไรลง DB`);
    console.log(`   จะ insert/update ${rows.length} แถวของ ${COMPANY} (คีย์ = companyCode + departmentId)`);
    console.log(`   รันจริง: bun run db:import:department --company=${COMPANY} --file=${CSV_NAME} --commit`);
    return;
  }

  // ทีเดียวจบในทรานแซกชันเดียว — พังกลางทางแล้วต้องไม่เหลือแผนกครึ่ง ๆ กลาง ๆ
  // ให้ employee รอบถัดไปไปผูกผิด
  await db.transaction(async (tx) => {
    await tx
      .insert(department)
      .values(rows.map((r) => ({ ...r, companyCode: COMPANY })))
      .onConflictDoUpdate({
        // คีย์คู่ ไม่ใช่ departmentId เดี่ยว — รหัสเดียวกันของคนละบริษัทคือคนละแผนก
        // ถ้ายังเป็นคีย์เดี่ยว การนำเข้า MIG จะ "อัปเดตทับ" แผนกของ UBA 32 แถวแบบเงียบ ๆ
        target: [department.companyCode, department.departmentId],
        set: { name: sql`excluded.name`, shortName: sql`excluded."shortName"`, updatedAt: sql`now()` },
      });
  });

  const after = await countDepartments();
  console.log(`\n✅ เขียนแล้ว — department ของ ${COMPANY}: ${before} → ${after} แถว (เพิ่ม ${after - before}, อัปเดต ${rows.length - (after - before)})`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('❌ import department ล้มเหลว:', e instanceof Error ? e.message : e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
