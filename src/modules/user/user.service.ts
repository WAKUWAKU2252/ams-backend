import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { user, role, employee } from '../../db/schema';
import { BadRequestError, ConflictError } from '../../common/errors';
import { createUserBody } from './user.schema';

type CreateUserInput = typeof createUserBody.static;

export async function createUser(input: CreateUserInput) {
  // username ห้ามซ้ำ (DB มี uq_user_username อยู่แล้ว แต่เช็คก่อนเพื่อคืนข้อความชัดกว่า error ดิบจาก pg)
  const dup = await db.query.user.findFirst({ where: eq(user.username, input.username) });
  if (dup) throw new ConflictError('username นี้ถูกใช้แล้ว');

  // เช็ค FK เองก่อน insert — ไม่งั้น pg โยน 23503 ดิบ ๆ เป็น 500 แทนที่จะเป็น 400 ข้อความชัด
  const roleExists = await db.query.role.findFirst({ where: eq(role.id, input.roleId) });
  if (!roleExists) throw new BadRequestError(`ไม่พบ role id ${input.roleId}`);

  if (input.employeeId != null) {
    const employeeExists = await db.query.employee.findFirst({ where: eq(employee.id, input.employeeId) });
    if (!employeeExists) throw new BadRequestError(`ไม่พบ employee id ${input.employeeId}`);
  }

  // เก็บเฉพาะ hash (argon2id จาก Bun.password) — ไม่เคยเก็บ plaintext
  const passwordHash = await Bun.password.hash(input.password);

  const [created] = await db
    .insert(user)
    .values({
      username: input.username,
      email: input.email ?? null,
      displayName: input.displayName,
      passwordHash,
      roleId: input.roleId,
      employeeId: input.employeeId ?? null,
    })
    .returning();

  return stripSecret(created);
}

// passwordHash ห้ามหลุดออก API — ตัดทิ้งก่อนคืนค่า
function stripSecret<T extends { passwordHash: string | null }>(row: T) {
  const { passwordHash: _omit, ...safe } = row;
  return safe;
}
