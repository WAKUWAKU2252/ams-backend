// ═══════════════════════════════════════════════════════════════════════════
// นำเข้า user จาก docs/user.csv
//
//   bun run db:import:user            → dry-run (ไม่แตะ DB) ← ค่าเริ่มต้น
//   bun run db:import:user --commit   → เขียนจริง
//
// ต้องรันหลัง db:import:role และ db:import:employee — ไฟล์ถือแต่ชื่อ role กับรหัส
// พนักงาน ส่วนคอลัมน์จริงเป็น FK ไป serial ที่ DB เป็นคนกำหนด
//
// ที่มา: ระบบเดิม — username/displayName/passwordHash ยกมาทั้งชุด
//   employeeEmpId = employee.empId (รหัสพนักงาน HR) ไม่ใช่ employee.id
//   ว่างได้สำหรับ account ที่ไม่ผูกพนักงาน (service account)
//
// ⚠️ passwordHash ในไฟล์เป็น MD5 (hex 32 ตัว) จากระบบเดิม — auth.service รับได้และ
// จะ upgrade เป็น argon2 ให้เองตอนคนนั้น login ครั้งแรกด้วยรหัสที่ถูก
// ดังนั้นตอนรันซ้ำ สคริปต์นี้ "ไม่เขียนทับ passwordHash" ของ user ที่มีอยู่แล้ว
// (ถ้าทับ = คนที่ upgrade เป็น argon2 ไปแล้วถูกดันกลับไปเป็น MD5 ทุกครั้งที่ import)
//
// รันซ้ำได้: ยึด username เป็นคีย์ธรรมชาติ (uq_user_username) ชนแล้วอัปเดต
// ═══════════════════════════════════════════════════════════════════════════
import { sql } from 'drizzle-orm';
import { db, pool } from '../index';
import { employee, role, user } from '../schema';
import { readCsv } from './csv';

const CSV = decodeURIComponent(
  new URL('../../../../../docs/user.csv', import.meta.url).pathname,
).replace(/^\/([A-Za-z]:)/, '$1');

const COMMIT = process.argv.includes('--commit');

type Row = {
  username: string;
  displayName: string;
  passwordHash: string;
  roleName: string;
  empId: string | null; // คีย์ธรรมชาติในไฟล์ — ยังไม่ใช่ employee.id ที่เขียนลง DB
};

function load(raw: Record<string, string>[]): Row[] {
  const rows: Row[] = [];
  const seenUser = new Map<string, number>();
  const seenEmp = new Map<string, number>();

  raw.forEach((r, i) => {
    const line = i + 2; // +1 ข้ามหัวคอลัมน์ +1 ให้เลขตรงกับที่เห็นในโปรแกรมแก้ไฟล์
    const username = (r.username ?? '').trim();
    const displayName = (r.displayName ?? '').trim();
    const passwordHash = (r.passwordHash ?? '').trim();
    const roleName = (r.roleName ?? '').trim();
    const empId = (r.employeeEmpId ?? '').trim();

    if (username === '') throw new Error(`บรรทัด ${line}: username ว่าง — เป็นคีย์ที่ใช้ล็อกอินและใช้จับคู่ตอนรันซ้ำ`);
    if (username.length > 100) throw new Error(`บรรทัด ${line}: username "${username}" ยาว ${username.length} เกิน varchar(100)`);
    if (displayName === '') throw new Error(`บรรทัด ${line}: displayName ว่าง (${username}) — คอลัมน์นี้ NOT NULL`);
    if (displayName.length > 100) throw new Error(`บรรทัด ${line}: displayName ยาว ${displayName.length} เกิน varchar(100)`);
    if (roleName === '') throw new Error(`บรรทัด ${line}: roleName ว่าง (${username}) — roleId เป็น NOT NULL ไม่มีค่า default`);
    if (empId.length > 20) throw new Error(`บรรทัด ${line}: employeeEmpId "${empId}" ยาว ${empId.length} เกิน varchar(20)`);

    // ว่างไม่ได้: user.passwordHash เป็น null ได้ในสคีมา (เผื่อ AD ในอนาคต) แต่ auth.service
    // ปฏิเสธ login ทุกครั้งที่เป็น null — import คนที่ล็อกอินไม่ได้เข้ามาเงียบ ๆ ไม่มีประโยชน์
    if (passwordHash === '') throw new Error(`บรรทัด ${line}: passwordHash ว่าง (${username}) — จะได้ account ที่ล็อกอินไม่ได้`);
    if (passwordHash.length > 255) throw new Error(`บรรทัด ${line}: passwordHash ยาว ${passwordHash.length} เกิน varchar(255)`);

    // ซ้ำในไฟล์เอง ON CONFLICT จะกลืนให้เงียบแล้วได้แถวหายโดยไม่รู้ตัว — ดักที่นี่
    const dupUser = seenUser.get(username);
    if (dupUser) throw new Error(`บรรทัด ${line}: username "${username}" ซ้ำกับบรรทัด ${dupUser}`);
    seenUser.set(username, line);

    // uq_user_employee: 1 พนักงาน = 1 account — ถ้าซ้ำในไฟล์ pg จะล้มกลางทางโดยไม่บอกบรรทัด
    if (empId !== '') {
      const dupEmp = seenEmp.get(empId);
      if (dupEmp) throw new Error(`บรรทัด ${line}: employeeEmpId "${empId}" ซ้ำกับบรรทัด ${dupEmp} — 1 พนักงานมีได้บัญชีเดียว`);
      seenEmp.set(empId, line);
    }

    rows.push({ username, displayName, passwordHash, roleName, empId: empId === '' ? null : empId });
  });

  return rows;
}

async function countUsers(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM "user"`);
  return res.rows[0]?.n ?? 0;
}

async function main() {
  const rows = load(await readCsv(CSV));

  const dbName = (await db.execute<{ db: string }>(sql`SELECT current_database() AS db`)).rows[0]?.db ?? '?';
  const before = await countUsers();

  // ── แปลงชื่อ role -> role.id
  const roleRows = await db.select({ id: role.id, name: role.name }).from(role);
  const roleIdByName = new Map(roleRows.map((r) => [r.name, r.id]));
  const missingRoles = [...new Set(rows.map((r) => r.roleName))].filter((n) => !roleIdByName.has(n));
  if (missingRoles.length) {
    throw new Error(
      `roleName ที่หาไม่เจอในตาราง role: ${missingRoles.join(', ')}\n` +
        `   → รัน db:import:role ก่อน (ตอนนี้ role มี ${roleRows.length} แถว: ${roleRows.map((r) => r.name).join(', ') || '-'})`,
    );
  }

  // ── แปลงรหัสพนักงาน -> employee.id
  const empRows = await db.select({ id: employee.id, empId: employee.empId }).from(employee);
  const empIdByCode = new Map(empRows.filter((e) => e.empId !== null).map((e) => [e.empId as string, e.id]));
  const missingEmps = [...new Set(rows.map((r) => r.empId).filter((v): v is string => v !== null))].filter(
    (c) => !empIdByCode.has(c),
  );
  if (missingEmps.length) {
    throw new Error(
      `employeeEmpId ที่หาไม่เจอในตาราง employee: ${missingEmps.join(', ')}\n` +
        `   → รัน db:import:employee ก่อน (ตอนนี้ employee ที่มี empId มี ${empIdByCode.size} แถว)`,
    );
  }

  const values = rows.map((r) => ({
    username: r.username,
    displayName: r.displayName,
    passwordHash: r.passwordHash,
    roleId: roleIdByName.get(r.roleName)!,
    employeeId: r.empId === null ? null : empIdByCode.get(r.empId)!,
  }));

  // ── พนักงานคนเดียวกันถูกจองไว้โดย username อื่นใน DB แล้ว
  // ON CONFLICT เล็ง username อย่างเดียว แถวแบบนี้จะไปชน uq_user_employee แทน แล้ว pg
  // ล้มทั้งทรานแซกชันด้วยข้อความที่บอกแค่ชื่อ constraint ไม่บอกว่าใครชนกับใคร
  const existingUsers = await db
    .select({ username: user.username, employeeId: user.employeeId })
    .from(user);
  const ownerByEmployee = new Map(
    existingUsers.filter((u) => u.employeeId !== null).map((u) => [u.employeeId as number, u.username]),
  );
  const stolen = values
    .filter((v) => v.employeeId !== null && (ownerByEmployee.get(v.employeeId) ?? v.username) !== v.username)
    .map((v) => `${v.username} → employee ${v.employeeId} (เป็นของ ${ownerByEmployee.get(v.employeeId!)})`);
  if (stolen.length) {
    throw new Error(
      `พนักงานถูกผูกกับ user อื่นใน DB อยู่แล้ว (1 พนักงาน = 1 account):\n   ${stolen.join('\n   ')}\n` +
        `   → ตัดสินใจก่อนว่าจะเก็บบัญชีไหน แล้วลบ/ปลดอีกบัญชีด้วยมือ`,
    );
  }

  // ── สัญญาณเตือนก่อนเขียน
  const noEmployee = values.filter((v) => v.employeeId === null);
  // auth.service แยกสองสายด้วยความยาว: 32 = MD5 จากระบบเก่า, ที่เหลือส่งเข้า argon2 verify
  const md5 = rows.filter((r) => /^[0-9a-fA-F]{32}$/.test(r.passwordHash)).length;
  const argon2 = rows.filter((r) => r.passwordHash.startsWith('$argon2')).length;
  const unknownHash = rows.filter(
    (r) => !/^[0-9a-fA-F]{32}$/.test(r.passwordHash) && !r.passwordHash.startsWith('$argon2'),
  );
  const byRole = [...new Set(rows.map((r) => r.roleName))].map((n) => `${n} ${rows.filter((r) => r.roleName === n).length}`);

  console.log(`ไฟล์      : ${CSV}`);
  console.log(`ฐานข้อมูล : ${dbName} (มี user อยู่แล้ว ${before} แถว, role ${roleRows.length} แถว, employee ${empRows.length} แถว)`);
  console.log(`อ่านได้   : ${rows.length} แถว (${byRole.join(' / ')})`);
  console.table(values.slice(0, 5).map((v) => ({ ...v, passwordHash: `${v.passwordHash.slice(0, 8)}…` })));

  if (noEmployee.length) {
    console.warn(
      `⚠️  ไม่ผูกพนักงาน ${noEmployee.length} คน (${noEmployee.map((v) => v.username).join(', ')}) — ` +
        `จะไม่มีอีเมล และหน้า "asset ของฉัน" จะว่างเสมอ (asset ไต่ผ่าน user.employeeId)`,
    );
  }
  if (md5) console.warn(`⚠️  รหัสผ่านเป็น MD5 จากระบบเก่า ${md5}/${rows.length} คน — auth.service จะ upgrade เป็น argon2 ให้เองตอน login ครั้งแรก`);
  if (unknownHash.length) {
    console.warn(
      `⚠️  passwordHash รูปแบบไม่รู้จัก ${unknownHash.length} คน (${unknownHash.slice(0, 5).map((r) => r.username).join(', ')}) — ` +
        `ไม่ใช่ MD5 hex 32 ตัวและไม่ใช่ argon2 PHC จะ login ไม่ผ่านทั้งสองสาย`,
    );
  }
  if (argon2) console.log(`   argon2 อยู่แล้ว ${argon2} คน`);

  // employee ที่ยังไม่มี account — ไม่ใช่ error แต่ต้องรู้ว่าเหลือใครที่เข้าระบบไม่ได้
  const linked = new Set(values.map((v) => v.employeeId).filter((v): v is number => v !== null));
  const orphanEmp = empRows.filter((e) => !linked.has(e.id)).length;
  if (orphanEmp) console.warn(`⚠️  employee ${orphanEmp}/${empRows.length} คนยังไม่มี user — เข้าระบบไม่ได้จนกว่าจะสร้างให้`);

  if (!COMMIT) {
    console.log(`\n🔍 dry-run — ยังไม่เขียนอะไรลง DB`);
    console.log(`   จะ insert/update ${rows.length} แถว (ยึด username เป็นคีย์ — ไม่เขียนทับ passwordHash ของคนที่มีอยู่แล้ว)`);
    console.log(`   รันจริง: bun run db:import:user --commit`);
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(user)
      .values(values)
      .onConflictDoUpdate({
        target: user.username,
        set: {
          displayName: sql`excluded."displayName"`,
          roleId: sql`excluded."roleId"`,
          employeeId: sql`excluded."employeeId"`,
          // ไม่แตะ passwordHash / isActive / deletedAt — ทั้งสามเป็นของที่ระบบหรือคน
          // เปลี่ยนหลัง import แล้ว (rehash argon2, ปิดบัญชี, ลบ) การรันไฟล์เดิมซ้ำ
          // ต้องไม่ย้อนสามอย่างนั้นคืนโดยไม่มีใครสั่ง
          updatedAt: sql`now()`,
        },
      });
  });

  const after = await countUsers();
  console.log(`\n✅ เขียนแล้ว — user: ${before} → ${after} แถว (เพิ่ม ${after - before}, อัปเดต ${rows.length - (after - before)})`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('❌ import user ล้มเหลว:', e instanceof Error ? e.message : e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
