import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { user } from '../../db/schema';
import { BadRequestError, UnauthorizedError } from '../../common/errors';
import { loginBody } from './auth.schema';

type LoginInput = typeof loginBody.static;

// ตรวจรหัสผ่าน — คืน user (ตัด passwordHash แล้ว) พร้อม role ให้ route เอาไป sign token
export async function verifyCredentials(input: LoginInput) {
  const found = await db.query.user.findFirst({
    where: and(eq(user.username, input.username), isNull(user.deletedAt)),
    with: { role: true },
  });

  // ข้อความเดียวกันทุกกรณีที่ล้มเหลว — กันเดาว่า username ไหนมีอยู่จริง
  const invalid = new BadRequestError('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  if (!found || !found.isActive || !found.passwordHash) throw invalid;

  const ok = await Bun.password.verify(input.password, found.passwordHash);
  if (!ok) throw invalid;

  return stripSecret(found);
}

export async function getMe(userId: number) {
  const found = await db.query.user.findFirst({
    where: and(eq(user.id, userId), isNull(user.deletedAt)),
    with: { role: true, employee: true },
  });
  if (!found) throw new UnauthorizedError('ไม่พบผู้ใช้');
  return stripSecret(found);
}

// passwordHash ห้ามหลุดออก API — ตัดทิ้งทุกครั้งก่อนคืนค่า
function stripSecret<T extends { passwordHash: string | null }>(row: T) {
  const { passwordHash: _omit, ...safe } = row;
  return safe;
}
