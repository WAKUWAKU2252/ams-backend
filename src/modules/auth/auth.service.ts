import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../../db';
import { user } from '../../db/schema';
import { BadRequestError, UnauthorizedError } from '../../common/errors';
import { loginBody } from './auth.schema';

type LoginInput = typeof loginBody.static;

// รหัสจาก DB เก่าที่ import เข้ามาเก็บเป็น MD5 (unsalted, hex 32 ตัว) — ตรวจได้แต่ไม่ปลอดภัยพอจะเก็บต่อ
// จึง upgrade เป็น argon2 ทันทีที่ login ด้วยรหัสที่ถูก (transparent rehash) แล้วเลิกใช้ MD5 ไปเอง
const createMd5 = (str: string) => new Bun.CryptoHasher('md5').update(str).digest('hex');

// argon2 (Bun.password) คืน PHC string ยาว ~95+ ตัว ส่วน MD5 hex = 32 ตัวเป๊ะ — ใช้ความยาวแยกสองสายได้
const isLegacyMd5Hash = (hash: string) => hash.length === 32;

// ตรวจรหัสผ่าน — คืน user (ตัด passwordHash แล้ว) พร้อม role ให้ route เอาไป sign token
export async function verifyCredentials(input: LoginInput) {
  const found = await db.query.user.findFirst({
    where: and(eq(user.username, input.username), isNull(user.deletedAt)),
    with: { role: true },
  });

  // ข้อความเดียวกันทุกกรณีที่ล้มเหลว — กันเดาว่า username ไหนมีอยู่จริง
  const invalid = new BadRequestError('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  if (!found || !found.isActive || !found.passwordHash) throw invalid;

  if (isLegacyMd5Hash(found.passwordHash)) {
    // สายรหัสเก่า (MD5 จาก DB ที่ import มา) — เทียบแบบ MD5; import บางระบบเก็บเป็นตัวพิมพ์ใหญ่ จึง normalize ก่อน
    if (createMd5(input.password).toLowerCase() !== found.passwordHash.toLowerCase()) throw invalid;
    // รหัสถูกเท่านั้นถึงมาถึงตรงนี้ — rehash เป็น argon2 แล้วเขียนทับทันที ครั้งต่อไปจะเข้าสายปกติ
    const upgraded = await Bun.password.hash(input.password);
    await db.update(user).set({ passwordHash: upgraded }).where(eq(user.id, found.id));
  } else {
    // สาย argon2 ปกติ
    const ok = await Bun.password.verify(input.password, found.passwordHash);
    if (!ok) throw invalid;
  }

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
