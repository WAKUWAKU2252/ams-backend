// ═══════════════════════════════════════════════════════════════════════════
// นำเข้า employee จาก docs/employee.csv
//
//   bun run db:import:employee            → dry-run (ไม่แตะ DB) ← ค่าเริ่มต้น
//   bun run db:import:employee --commit   → เขียนจริง
//
// ที่มา: v_hr_emp_final.csv (ระบบ HR) — ชื่อไทย/อังกฤษ, รหัสพนักงาน, อีเมล, แผนก
//
// ⚠️ ownerCode ว่างทั้งไฟล์ — ยังไม่ได้ผล OHEM จาก SAP
// คอลัมน์นั้นคือจุดเชื่อมเดียวระหว่าง PO กับผู้ขอ (OPOR.OwnerCode -> employee.ownerCode
// -> employee.id ดู po.connector.ts) ตราบใดที่ยังว่าง purchase_order.ownerPrId
// จะเป็น NULL ทุกใบ และคำขออนุมัติจะหาผู้ขอไม่เจอ — ต้องกลับมาเติมให้ครบ
//
// รันซ้ำได้: ยึด empId เป็นคีย์ธรรมชาติ (uq_employee_emp_id) ชนแล้วอัปเดต
// ตั้งใจให้รันใหม่ได้เมื่อ HR ส่งไฟล์ใหม่ หรือเมื่อเติม ownerCode ทีหลัง
// ═══════════════════════════════════════════════════════════════════════════
import { sql } from 'drizzle-orm';
import { db, pool } from '../index';
import { department, employee } from '../schema';
import { readCsv, toBool } from './csv';

const CSV = decodeURIComponent(
  new URL('../../../../../docs/employee.csv', import.meta.url).pathname,
).replace(/^\/([A-Za-z]:)/, '$1');

const COMMIT = process.argv.includes('--commit');

type Row = {
  empId: string | null;
  firstName: string | null;
  lastName: string | null;
  firstNameEn: string | null;
  lastNameEn: string | null;
  email: string | null;
  departmentKey: string; // คีย์ธรรมชาติในไฟล์ — ยังไม่ใช่ค่าที่เขียนลง DB
  isActive: boolean;
  ownerCode: number | null;
};

function load(raw: Record<string, string>[]): Row[] {
  const rows: Row[] = [];
  const seenEmp = new Map<string, number>();
  const seenOwner = new Map<string, number>();
  const seenEmail = new Map<string, number>();

  raw.forEach((r, i) => {
    const line = i + 2;
    const empId = (r.empId ?? '').trim();
    const owner = (r.ownerCode ?? '').trim();
    const departmentKey = (r.departmentId ?? '').trim();
    const who = empId || `ownerCode ${owner}`;

    // ต้องมีคีย์ธรรมชาติอย่างน้อยหนึ่ง ไม่งั้นรันซ้ำแล้วได้แถวซ้ำเรื่อย ๆ
    //   พนักงานปัจจุบันจาก HR   -> มี empId
    //   อดีตพนักงานที่พบใน OHEM -> ไม่มี empId (HR ไม่รู้จัก) แต่มี ownerCode
    if (empId === '' && owner === '') {
      throw new Error(`บรรทัด ${line}: ไม่มีทั้ง empId และ ownerCode — ไม่มีคีย์ให้จับคู่ตอนรันซ้ำ`);
    }
    if (empId.length > 20) throw new Error(`บรรทัด ${line}: empId "${empId}" ยาว ${empId.length} เกิน varchar(20)`);
    if (departmentKey === '') throw new Error(`บรรทัด ${line}: departmentId ว่าง (${who}) — คอลัมน์นี้ NOT NULL ถ้ายังไม่รู้แผนกให้ใส่ '-1'`);

    // ซ้ำในไฟล์เอง ON CONFLICT จะกลืนให้เงียบแล้วได้แถวหายโดยไม่รู้ตัว — ดักที่นี่
    if (empId !== '') {
      const dupEmp = seenEmp.get(empId);
      if (dupEmp) throw new Error(`บรรทัด ${line}: empId "${empId}" ซ้ำกับบรรทัด ${dupEmp}`);
      seenEmp.set(empId, line);
    }
    if (owner !== '') {
      const dupOwner = seenOwner.get(owner);
      if (dupOwner) throw new Error(`บรรทัด ${line}: ownerCode "${owner}" ซ้ำกับบรรทัด ${dupOwner}`);
      seenOwner.set(owner, line);
    }

    const email = (r.email ?? '').trim();
    if (email !== '') {
      // uq_employee_email กันซ้ำอยู่แล้ว แต่ error ของ pg ไม่บอกว่าอยู่บรรทัดไหนในไฟล์
      const dupMail = seenEmail.get(email);
      if (dupMail) throw new Error(`บรรทัด ${line}: email "${email}" ซ้ำกับบรรทัด ${dupMail}`);
      seenEmail.set(email, line);
      if (email.length > 100) throw new Error(`บรรทัด ${line}: email ยาว ${email.length} เกิน varchar(100)`);
    }

    for (const k of ['firstName', 'lastName', 'firstNameEn', 'lastNameEn'] as const) {
      const v = (r[k] ?? '').trim();
      if (v.length > 100) throw new Error(`บรรทัด ${line}: ${k} ยาว ${v.length} เกิน varchar(100)`);
    }

    if (owner !== '' && !/^\d+$/.test(owner)) {
      throw new Error(`บรรทัด ${line}: ownerCode "${owner}" ไม่ใช่จำนวนเต็ม (OHEM.empID เป็น int)`);
    }

    const blank = (v: string | undefined) => {
      const s = (v ?? '').trim();
      return s === '' ? null : s;
    };

    rows.push({
      empId: empId === '' ? null : empId,
      firstName: blank(r.firstName),
      lastName: blank(r.lastName),
      firstNameEn: blank(r.firstNameEn),
      lastNameEn: blank(r.lastNameEn),
      email: blank(r.email),
      departmentKey,
      isActive: toBool(r.isActive ?? '', true),
      ownerCode: owner === '' ? null : Number(owner),
    });
  });

  return rows;
}

async function countEmployees(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM employee`);
  return res.rows[0]?.n ?? 0;
}

async function main() {
  const rows = load(await readCsv(CSV));

  const dbName = (await db.execute<{ db: string }>(sql`SELECT current_database() AS db`)).rows[0]?.db ?? '?';
  const before = await countEmployees();

  // แปลงคีย์ธรรมชาติ -> department.id
  // ไฟล์ถือรหัสที่คนอ่านรู้เรื่อง ('775', '-1') ส่วนคอลัมน์จริงเป็น FK ไป serial
  // ต้องอ่านจาก DB ไม่ใช่จาก department-sap.csv เพราะ serial ถูกกำหนดตอน insert
  const depRows = await db.select({ id: department.id, key: department.departmentId }).from(department);
  const depIdByKey = new Map(depRows.filter((d) => d.key !== null).map((d) => [d.key as string, d.id]));

  const missing = [...new Set(rows.map((r) => r.departmentKey))].filter((k) => !depIdByKey.has(k));
  if (missing.length) {
    throw new Error(
      `departmentId ที่หาไม่เจอในตาราง department: ${missing.join(', ')}\n` +
        `   → รัน db:import:department ก่อน (ตอนนี้ department มี ${depRows.length} แถว)`,
    );
  }

  const values = rows.map((r) => ({
    empId: r.empId,
    firstName: r.firstName,
    lastName: r.lastName,
    firstNameEn: r.firstNameEn,
    lastNameEn: r.lastNameEn,
    email: r.email,
    departmentId: depIdByKey.get(r.departmentKey)!,
    isActive: r.isActive,
    ownerCode: r.ownerCode,
  }));

  const noOwner = values.filter((v) => v.ownerCode === null).length;
  const unassigned = rows.filter((r) => r.departmentKey === '-1').length;
  const noEmail = values.filter((v) => v.email === null).length;
  const former = values.filter((v) => v.empId === null).length;

  console.log(`ไฟล์      : ${CSV}`);
  console.log(`ฐานข้อมูล : ${dbName} (มี employee อยู่แล้ว ${before} แถว, department ${depRows.length} แถว)`);
  console.log(`อ่านได้   : ${rows.length} แถว (จาก HR ${rows.length - former} / ไม่มีใน HR ใช้ ownerCode เป็นคีย์ ${former})`);
  console.table(values.slice(0, 5));

  if (noOwner) console.warn(`⚠️  ownerCode ว่าง ${noOwner}/${rows.length} คน — PO จะ resolve ผู้ขอไม่ได้จนกว่าจะเติม`);
  if (unassigned) console.warn(`⚠️  อยู่แถวพัก '-1' (ยังไม่ระบุแผนก) ${unassigned} คน`);
  if (noEmail) console.warn(`⚠️  ไม่มีอีเมล ${noEmail} คน — reset รหัสผ่านเองไม่ได้`);

  if (!COMMIT) {
    console.log(`\n🔍 dry-run — ยังไม่เขียนอะไรลง DB`);
    console.log(`   จะ insert/update ${rows.length} แถว (ยึด empId เป็นคีย์)`);
    console.log(`   รันจริง: bun run db:import:employee --commit`);
    return;
  }

  // ── ค่าที่อัปเดตเมื่อชนคีย์ — ใช้ร่วมกันทั้งสองกลุ่ม
  // COALESCE ที่ email/ownerCode: ไฟล์ที่ยังไม่มีค่าต้องไม่ลบของที่เคยเติมไว้แล้ว
  // (รันซ้ำด้วยไฟล์เดิมหลังเติม ownerCode มือ = ค่าหายทั้งตาราง ถ้าเขียนทับตรง ๆ)
  const onUpdate = {
    firstName: sql`excluded."firstName"`,
    lastName: sql`excluded."lastName"`,
    firstNameEn: sql`excluded."firstNameEn"`,
    lastNameEn: sql`excluded."lastNameEn"`,
    email: sql`COALESCE(excluded.email, ${employee.email})`,
    ownerCode: sql`COALESCE(excluded."ownerCode", ${employee.ownerCode})`,
    departmentId: sql`excluded."departmentId"`,
    isActive: sql`excluded."isActive"`,
    updatedAt: sql`now()`,
  };

  // แยกสองก้อนเพราะคีย์ธรรมชาติคนละตัว — ON CONFLICT รับ target ได้ทีละอัน
  // และ pg ยอมให้ NULL ซ้ำได้ในคอลัมน์ unique ถ้ายิงก้อนเดียวโดยเล็ง empId
  // แถวที่ empId เป็น NULL จะไม่ชนอะไรเลย แล้วเพิ่มแถวใหม่ทุกครั้งที่รันซ้ำ
  const byEmpId = values.filter((v) => v.empId !== null);
  const byOwner = values.filter((v) => v.empId === null);

  await db.transaction(async (tx) => {
    if (byEmpId.length) {
      await tx.insert(employee).values(byEmpId).onConflictDoUpdate({ target: employee.empId, set: onUpdate });
    }
    if (byOwner.length) {
      await tx.insert(employee).values(byOwner).onConflictDoUpdate({ target: employee.ownerCode, set: onUpdate });
    }
  });

  const after = await countEmployees();
  console.log(`\n✅ เขียนแล้ว — employee: ${before} → ${after} แถว (เพิ่ม ${after - before}, อัปเดต ${rows.length - (after - before)})`);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('❌ import employee ล้มเหลว:', e instanceof Error ? e.message : e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
