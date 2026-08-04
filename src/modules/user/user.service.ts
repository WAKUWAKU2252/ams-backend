import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { user, role, employee, userEmail } from '../../db/schema';
import { BadRequestError, ConflictError } from '../../common/errors';
import { createUserBody } from './user.schema';

type CreateUserInput = typeof createUserBody.static;

export async function createUser(input: CreateUserInput) {
  const dup = await db.query.user.findFirst({ where: eq(user.username, input.username) });
  if (dup) throw new ConflictError('username นี้ถูกใช้แล้ว');

  const roleExists = await db.query.role.findFirst({ where: eq(role.id, input.roleId) });
  if (!roleExists) throw new BadRequestError(`ไม่พบ role id ${input.roleId}`);

  if (input.employeeId != null) {
    const employeeExists = await db.query.employee.findFirst({ where: eq(employee.id, input.employeeId) });
    if (!employeeExists) throw new BadRequestError(`ไม่พบ employee id ${input.employeeId}`);
  }

  const passwordHash = await Bun.password.hash(input.password);

  // สร้าง user + email หลัก (ถ้าส่งมา) ใน transaction เดียว — email ย้ายไปอยู่ตาราง user_email แล้ว
  // ต้อง atomic: ถ้า insert email ล้มเหลว ต้องไม่เหลือ user ค้างที่ไม่มี email หลัก
  const created = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(user)
      .values({
        username: input.username,
        displayName: input.displayName,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        passwordHash,
        roleId: input.roleId,
        employeeId: input.employeeId ?? null,
      })
      .returning();

    // email แรกที่ส่งมาตอนสร้าง = ตัวหลัก (PRIMARY)
    if (input.email) {
      await tx.insert(userEmail).values({ userId: row.id, email: input.email, status: 'PRIMARY' });
    }

    return row;
  });

  return stripSecret(created);
}

function stripSecret<T extends { passwordHash: string | null }>(row: T) {
  const { passwordHash: _omit, ...safe } = row;
  return safe;
}
