// ═══════════════════════════════════════════════════════════════════════════
// สร้าง role พื้นฐาน 4 ตัว
//
//   bun run db:import:role            → dry-run (ไม่แตะ DB) ← ค่าเริ่มต้น
//   bun run db:import:role --commit   → เขียนจริง
//
// ไม่อ่านจาก CSV เหมือน department/employee เพราะ role ไม่ใช่ข้อมูลจากระบบภายนอก —
// ชื่อพวกนี้ถูกอ้างเป็นสตริงตรง ๆ ในโค้ด (requireRole('MANAGER') ฯลฯ) ถ้าปล่อยให้แก้
// ผ่านไฟล์ได้ วันที่ใครพิมพ์ 'Manager' ลงไฟล์ route จะ 403 ทุกคำขอโดยไม่มีอะไรฟ้อง
// ที่มาของรายชื่อจึงเป็นตัวโค้ดเอง: grep requireRole( ใน src/modules
//
// รันซ้ำได้: ยึด name เป็นคีย์ธรรมชาติ (uq_role_name) ชนแล้วอัปเดตแค่คำอธิบาย
// ไม่แตะ isActive — ถ้าใครปิด role ไว้ตั้งใจ การรันสคริปต์ใหม่ต้องไม่เปิดคืนให้เงียบ ๆ
// ═══════════════════════════════════════════════════════════════════════════
import { sql } from 'drizzle-orm';
import { db, pool } from '../index';
import { role } from '../schema';

const COMMIT = process.argv.includes('--commit');

// ต้องตรงกับสตริงใน requireRole(...) เป๊ะ ทั้งตัวพิมพ์ใหญ่-เล็ก
const ROLES = [
  { name: 'EMPLOYEE', description: 'พนักงานทั่วไป — เปิดคำขอและดู asset ของตัวเอง' },
  { name: 'MANAGER', description: 'หัวหน้าแผนก — อนุมัติ/ปฏิเสธคำขอลงทะเบียนของแผนก' },
  { name: 'FINANCE', description: 'บัญชี/การเงิน — ดูข้อมูลมูลค่าสินทรัพย์และสั่ง sync SAP' },
  { name: 'ADMIN', description: 'ผู้ดูแลระบบ — จัดการผู้ใช้และสิทธิ์' },
] as const;

async function main() {
  const dbName = (await db.execute<{ db: string }>(sql`SELECT current_database() AS db`)).rows[0]?.db ?? '?';
  const existing = await db.select({ id: role.id, name: role.name, isActive: role.isActive }).from(role);
  const have = new Set(existing.map((r) => r.name));

  console.log(`ฐานข้อมูล : ${dbName} (มี role อยู่แล้ว ${existing.length} แถว)`);
  console.table(ROLES.map((r) => ({ ...r, สถานะ: have.has(r.name) ? 'มีอยู่แล้ว' : 'จะเพิ่มใหม่' })));

  // role แปลกปลอมที่ไม่มีในโค้ด — user ที่ถือ role นี้จะผ่าน requireRole ไม่ได้สักเส้นทาง
  const extra = existing.filter((r) => !ROLES.some((x) => x.name === r.name));
  if (extra.length) console.warn(`⚠️  มี role ที่โค้ดไม่รู้จัก: ${extra.map((r) => r.name).join(', ')} — ไม่มี route ไหนยอมรับ`);

  const off = existing.filter((r) => !r.isActive);
  if (off.length) console.warn(`⚠️  role ที่ปิดใช้อยู่: ${off.map((r) => r.name).join(', ')} — สคริปต์นี้ไม่เปิดคืนให้`);

  if (!COMMIT) {
    console.log(`\n🔍 dry-run — ยังไม่เขียนอะไรลง DB`);
    console.log(`   จะเพิ่ม ${ROLES.filter((r) => !have.has(r.name)).length} / อัปเดตคำอธิบาย ${ROLES.filter((r) => have.has(r.name)).length}`);
    console.log(`   รันจริง: bun run db:import:role --commit`);
    return;
  }

  await db
    .insert(role)
    .values([...ROLES])
    .onConflictDoUpdate({
      target: role.name,
      set: { description: sql`excluded.description`, updatedAt: sql`now()` },
    });

  const after = await db.select({ id: role.id, name: role.name }).from(role);
  console.log(`\n✅ เขียนแล้ว — role: ${existing.length} → ${after.length} แถว`);
  console.table(after);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (e) => {
    console.error('❌ import role ล้มเหลว:', e instanceof Error ? e.message : e);
    await pool.end().catch(() => {});
    process.exit(1);
  });
