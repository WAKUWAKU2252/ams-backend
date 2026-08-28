// ═══════════════════════════════════════════════════════════════════════════
// นำเข้าตัวตนฝั่ง UBP ลง employee.ownerCodeUbp   (0021 เฟส 2c — POC)
//
//   bun run db:import:employee-ubp            → dry-run (rollback เสมอ) ← ค่าเริ่มต้น
//   bun run db:import:employee-ubp --commit   → เขียนจริง
//
// ต่างจาก import ตัวอื่นในโฟลเดอร์นี้ตรงที่ตัวข้อมูลอยู่ในไฟล์ .sql ไม่ใช่ CSV —
// เพราะมันไม่ใช่ "นำเข้าตารางอ้างอิง" แต่เป็นการ **แก้แถวที่มีอยู่แล้ว 150 แถว**
// บวกเพิ่มใหม่ 116 แถว ซึ่งอ่านเป็น SQL ตรง ๆ แล้วเห็นภาพชัดกว่าอ่านผ่านโค้ดที่ประกอบให้
//
// ไฟล์ .sql ถูกประกอบจาก docs/Book1.xlsx ด้วยสคริปต์ ไม่ได้พิมพ์มือ — การจับคู่คน
// ใช้ "ชื่อ + นามสกุลตรงกันเป๊ะ และไม่ซ้ำทั้งสองฝั่ง" ส่วนชื่อที่กำกวมถูกข้ามทั้งหมด
// (ดูหัวไฟล์ .sql) คนกลุ่มที่ข้ามจะเป็นคนละคนในสายตาระบบจนกว่าจะมีคนมาตัดสิน
//
// ⚠️ ถ้าไฟล์ .sql ถูกสร้างใหม่จาก Book1 รุ่นอื่น ตัวเลขที่คาดหวังข้างล่างจะไม่ตรง —
//    สคริปต์จะรายงานตัวเลขจริงให้เทียบเอง ไม่ได้ hard fail เพราะ Book1 แก้ได้ตลอด
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db, pool } from '../index';

const COMMIT = process.argv.includes('--commit');

// path สัมพัทธ์กับ cwd ตอนรัน (= ams-backend) เหมือน import ตัวอื่นที่อ่าน ../docs
const SQL_FILE = '../docs/import-employee-ubp.sql';

type Counts = { employee_all: number; has_uba: number; has_ubp: number; both_codes: number };

const COUNT_SQL = sql`
  SELECT count(*)::int                                   AS employee_all,
         count("ownerCodeUba")::int                      AS has_uba,
         count("ownerCodeUbp")::int                      AS has_ubp,
         count(*) FILTER (WHERE "ownerCodeUba" IS NOT NULL
                            AND "ownerCodeUbp" IS NOT NULL)::int AS both_codes
  FROM employee
`;

async function main() {
  const dbName =
    (await db.execute<{ db: string }>(sql`SELECT current_database() AS db`)).rows[0]?.db ?? '?';

  // กันยิงผิดฐาน — เครื่องเดียวกันมี core_business อยู่ด้วย (113 ตารางของระบบงานคนละตัว)
  if (dbName !== 'ams_db') {
    throw new Error(`ต่ออยู่กับฐาน '${dbName}' ไม่ใช่ ams_db — ตรวจ DB_NAME ใน .env ก่อน`);
  }

  const statements = readFileSync(SQL_FILE, 'utf8');
  const before = (await db.execute<Counts>(COUNT_SQL)).rows[0]!;

  console.log(`ฐานข้อมูล : ${dbName}`);
  console.log(`ไฟล์ SQL  : ${SQL_FILE}`);
  console.log('');

  // ทั้งก้อนอยู่ใน transaction เดียว — ไฟล์ .sql ไม่มี BEGIN/COMMIT ของตัวเอง
  // โยน error ออกจาก callback = drizzle rollback ให้เอง ซึ่งเป็นทางเดียวกับ dry-run
  const after = await db
    .transaction(async (tx) => {
      await tx.execute(sql.raw(statements));
      const rows = (await tx.execute<Counts>(COUNT_SQL)).rows[0]!;
      if (!COMMIT) throw new DryRun(rows);
      return rows;
    })
    .catch((e) => {
      if (e instanceof DryRun) return e.counts;
      throw e;
    });

  const delta = (k: keyof Counts) => {
    const d = after[k] - before[k];
    return d === 0 ? '—' : (d > 0 ? '+' : '') + d;
  };
  console.table([
    { แถว: 'employee ทั้งหมด', ก่อน: before.employee_all, หลัง: after.employee_all, เปลี่ยน: delta('employee_all') },
    { แถว: 'มี ownerCodeUba', ก่อน: before.has_uba, หลัง: after.has_uba, เปลี่ยน: delta('has_uba') },
    { แถว: 'มี ownerCodeUbp', ก่อน: before.has_ubp, หลัง: after.has_ubp, เปลี่ยน: delta('has_ubp') },
    { แถว: 'ถือทั้งสองเลข', ก่อน: before.both_codes, หลัง: after.both_codes, เปลี่ยน: delta('both_codes') },
  ]);

  console.log('');
  console.log('ตัวเลขที่คาดไว้จากไฟล์ที่ประกอบมา: has_ubp = 266 · both_codes = 242 · employee +116');
  console.log('');
  console.log(
    COMMIT
      ? '✅ commit แล้ว'
      : '🔍 dry-run — rollback ไปแล้ว ไม่มีอะไรถูกเขียน (ใส่ --commit เพื่อเขียนจริง)',
  );
}

/** ใช้เด้งออกจาก transaction ให้ drizzle rollback — ไม่ใช่ error จริง */
class DryRun extends Error {
  constructor(readonly counts: Counts) {
    super('dry-run');
  }
}

main()
  .catch((e) => {
    console.error('❌', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
