// ชื่อคนที่จะไปโชว์บนป้าย "กำลังแก้ไขโดย ..." — แยกออกมาจาก presence.service โดยตั้งใจ
// เพื่อให้ presence.service เป็น in-memory ล้วน ไม่ต้องมี DB ตอนเทสต์
//
// JWT มีแค่ { id, role } (ดู plugins/auth.ts) จึงต้องแปลง id เป็นชื่อที่นี่
// ยิงคิวรีแค่ตอน "เปิดสาย" ครั้งแรกของแต่ละคน ไม่ใช่ทุก broadcast — broadcast เกิดทุกครั้ง
// ที่มีคนเข้า/ออกห้อง ซึ่งบ่อยกว่าการเปิดสายหลายเท่า
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { employee, user } from '@intrastucture/db/schema';
import { documentPersonName } from '@modules/business/master/master.service';

const cache = new Map<number, string>();

/** ชื่อที่ใช้เรียกคนคนนี้ตามกติกาเดียวกับทั้งระบบ (ชื่อพนักงานก่อน ไม่มีค่อยใช้ displayName) */
export async function displayNameOf(userId: number): Promise<string> {
  const hit = cache.get(userId);
  if (hit !== undefined) return hit;

  const [row] = await db
    .select({
      displayName: user.displayName,
      firstName: employee.firstName,
      lastName: employee.lastName,
      firstNameEn: employee.firstNameEn,
      lastNameEn: employee.lastNameEn,
      empId: employee.empId,
    })
    .from(user)
    // leftJoin: user ที่ยังไม่ผูกพนักงาน (service account) ต้องได้ชื่อกลับไปด้วย
    .leftJoin(employee, eq(employee.id, user.employeeId))
    .where(eq(user.id, userId));

  const name = documentPersonName(row);
  cache.set(userId, name);
  return name;
}

/**
 * ล้าง cache ของคนคนหนึ่ง — cache ไม่มี TTL โดยตั้งใจ (ชื่อคนแทบไม่เปลี่ยน การตั้ง TTL
 * แปลว่ายิงคิวรีซ้ำเรื่อย ๆ เพื่อรอเหตุการณ์ที่นาน ๆ เกิดที)
 *
 * ⚠️ ตอนนี้ยังไม่มีอะไรเรียก เพราะระบบยังไม่มี endpoint แก้ชื่อ/ผูกพนักงานใหม่ (user.service
 * มีแค่ createUser) — ตัวนี้มีไว้ให้คนที่เพิ่ม endpoint นั้นในอนาคตเรียก ไม่งั้นคนอื่นจะเห็น
 * ชื่อเก่าบนป้าย "กำลังแก้ไขโดย ..." ไปจนกว่าจะรีสตาร์ท process
 */
export function forgetName(userId: number): void {
  cache.delete(userId);
}
