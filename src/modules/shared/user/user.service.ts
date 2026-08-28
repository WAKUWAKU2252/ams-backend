import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { user, role, employee, department } from '@intrastucture/db/schema';
import { BadRequestError, ConflictError } from '@common/errors';
import { requireRow } from '@common/db-result';
import { isUniqueViolation, pgConstraint } from '@common/pg-error';
import type { CreateUserInput, PublicUser, UserRow } from './user.types';

export async function createUser(input: CreateUserInput): Promise<PublicUser> {
  const dup = await db.query.user.findFirst({ where: eq(user.username, input.username) });
  if (dup) throw new ConflictError('username นี้ถูกใช้แล้ว');

  const roleExists = await db.query.role.findFirst({ where: eq(role.id, input.roleId) });
  if (!roleExists) throw new BadRequestError(`ไม่พบ role id ${input.roleId}`);

  // ผูกคนเดิม หรือ สร้างคนใหม่ — อย่างใดอย่างหนึ่ง ส่งมาทั้งคู่แปลว่าคนเรียกยังไม่ได้ตัดสินใจ
  // ถ้าปล่อยผ่านโดยเลือกให้เอง (เช่นเอา employeeId ก่อน) ข้อมูลพนักงานที่กรอกมาจะหายเงียบ ๆ
  if (input.employeeId != null && input.employee) {
    throw new BadRequestError(
      'เลือกได้อย่างเดียว: ผูกกับพนักงานที่มีอยู่ (employeeId) หรือสร้างพนักงานใหม่ (employee)',
    );
  }

  if (input.employeeId != null) {
    const employeeExists = await db.query.employee.findFirst({ where: eq(employee.id, input.employeeId) });
    if (!employeeExists) throw new BadRequestError(`ไม่พบ employee id ${input.employeeId}`);
  }

  if (input.employee) {
    // FK จับได้ว่า id ไม่มีจริง แต่ไม่จับ "แผนกที่ถูกปิดใช้งาน" (แถวยังอยู่ FK จึงผ่าน)
    // และ error ของ pg อ่านไม่รู้เรื่องสำหรับคนกรอกฟอร์ม — เช็คเองให้ข้อความตรงประเด็น
    const dept = await db.query.department.findFirst({
      where: eq(department.id, input.employee.departmentId),
    });
    if (!dept) throw new BadRequestError(`ไม่พบแผนก id ${input.employee.departmentId}`);
    if (!dept.isActive) throw new BadRequestError(`แผนก "${dept.name}" ถูกปิดใช้งานแล้ว`);
  }

  const passwordHash = await Bun.password.hash(input.password);

  // ★ ต้องเป็น transaction เมื่อสร้างพนักงานไปด้วย — ถ้า insert user ล้มทีหลัง (username ชน
  // ที่หลุดจากด่านข้างบนเพราะมีคนแทรกพอดี) แถว employee ที่เพิ่งสร้างจะค้างเป็นพนักงานผี
  // ที่ไม่มีใครใช้ และไปกิน uq_employee_email/emp_id ของคนจริงที่จะ import เข้ามาทีหลัง
  //
  // อีเมลไม่ได้รับที่ระดับ user (0005): แหล่งเดียวคือ employee.email ซึ่งมาจาก HR/SAP
  const created = await insertUserWithEmployee(input, passwordHash);

  return stripSecret(created);
}

/**
 * ข้อความของ unique ที่ชนได้ตอนสร้าง user/พนักงาน
 *
 * ★ ทั้งหมดนี้เคยหลุดเป็น 500 "Internal server error" — ซึ่งคนกรอกฟอร์มอ่านแล้วไม่รู้เลยว่า
 * ตัวเองทำอะไรผิด และแอดมินก็ต้องไปเปิด log ของ backend ถึงจะรู้ว่าชนอะไร
 * (เจอจริงกับ uq_employee_email: อีเมลที่กรอกมีพนักงานคนอื่นถืออยู่แล้ว)
 *
 * ทุกอันบอก "ต้องทำยังไงต่อ" ด้วย ไม่ใช่แค่บอกว่าซ้ำ — ส่วนใหญ่ทางออกคือไปใช้โหมด
 * "ผูกพนักงานที่มีอยู่" แทนการสร้างใหม่ ซึ่งคนกรอกไม่มีทางเดาเองได้
 */
const UNIQUE_MESSAGE: Record<string, string> = {
  uq_employee_email: 'อีเมลนี้มีพนักงานคนอื่นใช้อยู่แล้ว — ถ้าเป็นคนเดียวกัน ให้ใช้โหมด "ผูกพนักงานที่มีอยู่" แทนการสร้างใหม่',
  uq_employee_emp_id: 'รหัสพนักงานนี้ถูกใช้แล้ว — ตรวจสอบว่าคนนี้มีอยู่ในระบบแล้วหรือยัง',
  uq_employee_owner_code: 'OwnerCode นี้ถูกใช้แล้ว — เป็นรหัสที่ SAP ใช้อ้างผู้ขอบน PO ซ้ำกันไม่ได้',
  uq_user_username: 'username นี้ถูกใช้แล้ว',
  uq_user_employee: 'พนักงานคนนี้มีบัญชีผู้ใช้อยู่แล้ว — 1 พนักงานมีได้บัญชีเดียว',
};

async function insertUserWithEmployee(
  input: CreateUserInput,
  passwordHash: string,
): Promise<UserRow> {
  try {
    return await runInsert(input, passwordHash);
  } catch (error) {
    if (isUniqueViolation(error)) {
      const constraint = pgConstraint(error);
      throw new ConflictError(
        (constraint && UNIQUE_MESSAGE[constraint]) ??
          'ข้อมูลซ้ำกับที่มีอยู่แล้วในระบบ กรุณาตรวจสอบอีกครั้ง',
      );
    }
    throw error;
  }
}

async function runInsert(input: CreateUserInput, passwordHash: string): Promise<UserRow> {
  return db.transaction(async (tx) => {
    let employeeId = input.employeeId ?? null;

    if (input.employee) {
      const e = input.employee;
      const inserted = await tx
        .insert(employee)
        .values({
          firstName: e.firstName,
          lastName: e.lastName ?? null,
          firstNameEn: e.firstNameEn ?? null,
          lastNameEn: e.lastNameEn ?? null,
          // สามช่องนี้เป็น unique ที่ยอมให้ NULL ซ้ำได้ — ส่งสตริงว่างมาแทน NULL เมื่อไหร่
          // คนที่สองจะสร้างไม่ได้เลยเพราะ '' ชนกับ '' (ต่างจาก NULL ที่ซ้ำได้)
          empId: e.empId?.trim() || null,
          email: e.email?.trim() || null,
          // ช่องของ UBA — คนที่สร้างผ่านหน้าจอเป็นพนักงาน UBA เป็นค่าตั้งต้น (0021)
          // คน UBP ต้องเติม ownerCodeUbp ทีหลัง ยังไม่มีหน้าจอให้กรอกสองช่อง
          ownerCodeUba: e.ownerCode ?? null,
          departmentId: e.departmentId,
        })
        .returning();
      employeeId = requireRow(inserted, `insert employee (${e.firstName})`).id;
    }

    return requireRow(
      await tx
        .insert(user)
        .values({
          username: input.username,
          displayName: input.displayName,
          passwordHash,
          roleId: input.roleId,
          employeeId,
        })
        .returning(),
      `insert user (${input.username})`,
    );
  });
}

/**
 * ตัด passwordHash ออกก่อนส่งกลับ API
 *
 * รับ UserRow เต็ม ๆ และคืน PublicUser ที่ประกาศไว้ชัดเจน — ไม่ใช้ generic
 * <T extends { passwordHash }> แบบเดิม เพราะแบบนั้นชนิดที่คืนออกไปขึ้นกับ input
 * ทำให้ไม่มีจุดไหนในโค้ดที่พูดว่า "หน้าตาของ user ที่ส่งออก API คืออะไร"
 */
function stripSecret(row: UserRow): PublicUser {
  const { passwordHash: _omit, ...safe } = row;
  return safe;
}
