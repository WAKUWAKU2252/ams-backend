// Seed roles + mock users — รันได้ซ้ำ (idempotent ด้วย onConflictDoNothing)
//   bun run db:seed
// สมมติว่า master (department/employee) มีอยู่แล้ว — สคริปต์นี้เติมแค่ role + user
// mock user ทุกคนรหัสผ่านเดียวกัน "password123" (dev เท่านั้น)
import { db } from './index';
import { role, user, userEmail } from './schema';

const MOCK_PASSWORD = 'password123';

async function seed() {
  // 3 roles ตามที่ตกลง — Employee (ค้น/เปิด PO, ลงทะเบียน), Manager (อนุมัติ), Finance (SAP+Audit)
  await db
    .insert(role)
    .values([
      { name: 'EMPLOYEE', description: 'พนักงานทั่วไป — ค้น/เปิด PO, ลงทะเบียน asset, ดู My Asset' },
      { name: 'MANAGER', description: 'ผู้จัดการ — ตรวจและอนุมัติคำขอ' },
      { name: 'FINANCE', description: 'บัญชี — ลงทะเบียน SAP + ทำ Audit' },
    ])
    .onConflictDoNothing({ target: role.name });

  // ดึง id กลับมา (returning หลัง conflict อาจว่าง จึง query สดให้ชัวร์)
  const roles = await db.select().from(role);
  const roleId = (name: string) => {
    const r = roles.find((x) => x.name === name);
    if (!r) throw new Error(`seed role ${name} หาย`);
    return r.id;
  };

  const passwordHash = await Bun.password.hash(MOCK_PASSWORD);

  await db
    .insert(user)
    .values([
      {
        username: 'employee',
        displayName: 'สมชาย ใจดี',
        passwordHash,
        roleId: roleId('EMPLOYEE'),
        employeeId: 1001, // ผูกกับ employee ที่ seed ไว้ — ใช้ตอบ My Asset
      },
      {
        username: 'manager',
        displayName: 'ผู้จัดการฝ่าย',
        passwordHash,
        roleId: roleId('MANAGER'),
        // ยังไม่ผูก employee (nullable) — manager ไม่จำเป็นต้องมี My Asset
      },
      {
        username: 'finance',
        displayName: 'สมหญิง รักงาน',
        passwordHash,
        roleId: roleId('FINANCE'),
        employeeId: 1002,
      },
    ])
    .onConflictDoNothing({ target: user.username });

  // email ย้ายไปตาราง user_email แล้ว — ใส่ตัวหลัก (PRIMARY) ให้ user ที่มี (query id กลับมาเพราะ serial)
  const primaryEmails: Record<string, string> = {
    employee: 'somchai.j@company.co.th',
    finance: 'somying.r@company.co.th',
  };
  const allUsers = await db.select().from(user);
  const emailRows = allUsers
    .filter((u) => primaryEmails[u.username])
    .map((u) => ({ userId: u.id, email: primaryEmails[u.username], status: 'PRIMARY' as const }));
  if (emailRows.length > 0) {
    await db.insert(userEmail).values(emailRows).onConflictDoNothing();
  }

  const count = (await db.select().from(user)).length;
  console.log(`✅ seed เสร็จ — roles: ${roles.length}, users ในระบบ: ${count}`);
  console.log(`   mock login: employee/manager/finance รหัสผ่าน "${MOCK_PASSWORD}"`);
}

seed()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('❌ seed ล้มเหลว:', e);
    process.exit(1);
  });
