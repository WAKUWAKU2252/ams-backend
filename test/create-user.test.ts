// ═══ สร้าง user (+ พนักงานใหม่ในคำสั่งเดียว) ═══
//
// หน้า Create User เป็นทางลัดของแอดมินสำหรับคนที่ HR ยังไม่ส่งข้อมูลมา — สร้าง employee
// กับ user พร้อมกันใน transaction เดียว ล้มกลางทางต้องไม่เหลือพนักงานผีค้างในตาราง
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { employee, employeeCompany, role, user } from '@intrastucture/db/schema';
import { createUser } from '@modules/shared/user/user.service';
import { makeDepartment, makeEmployee, resetDb } from './helpers/factory';

let departmentId: number;
let roleId: number;

beforeEach(async () => {
  await resetDb();
  departmentId = await makeDepartment();
  const [r] = await db.insert(role).values({ name: 'EMPLOYEE' }).returning();
  roleId = r!.id;
});

const base = (over: Record<string, unknown> = {}) => ({
  username: `u_${Math.random().toString(36).slice(2, 8)}`,
  displayName: 'ผู้ใช้ใหม่',
  password: 'secret',
  roleId,
  ...over,
});

describe('createUser', () => {
  test('สร้าง user พร้อมพนักงานใหม่ในคำสั่งเดียว', async () => {
    const created = await createUser(
      base({
        employee: { firstName: 'ณัฐดนัย', lastName: 'ศรีพล', departmentId },
      }) as never,
    );

    expect(created.employeeId).not.toBeNull();
    const emp = await db.query.employee.findFirst({
      where: eq(employee.id, created.employeeId!),
    });
    expect(emp!.firstName).toBe('ณัฐดนัย');
    expect(emp!.departmentId).toBe(departmentId);
    // ห้ามมี passwordHash หลุดออก API
    expect('passwordHash' in created).toBe(false);
  });

  // ── ตัวตนรายบริษัทต้องเกิดพร้อมพนักงานเสมอ (0025) ─────────────────────────
  //
  // ก่อน 0025 บรรทัดนี้เขียน employee.ownerCodeUba ตายตัว = คนที่ถูกสร้างให้แผนกของ
  // UBP/MIG จะได้ตัวตนฝั่ง UBA แทน แล้ว PO ของบริษัทเขา resolve ผู้ขอไม่เจอ
  // และถ้าไม่สร้างแถวนี้เลย คนนั้นจะ "มีอยู่" แต่ส่งคำขอไม่ได้โดยไม่มีอะไรบอกว่าทำไม
  test('★ สร้างพนักงานใหม่ = ได้แถว employee_company ของบริษัทตามแผนกที่เลือก', async () => {
    const ubpDept = await makeDepartment('จัดซื้อ UBP', 'UBP');
    const created = await createUser(
      base({
        employee: { firstName: 'ทดสอบ', lastName: 'ยูบีพี', departmentId: ubpDept, ownerCode: 4242 },
      }) as never,
    );

    const [link] = await db
      .select()
      .from(employeeCompany)
      .where(eq(employeeCompany.employeeId, created.employeeId!));

    // ★ ต้องเป็น UBP ตามแผนก ไม่ใช่ UBA ตามค่าตั้งต้นเดิม
    expect(link!.companyCode).toBe('UBP');
    expect(link!.departmentId).toBe(ubpDept);
    expect(link!.ownerCode).toBe(4242);
  });

  test('OwnerCode ซ้ำในบริษัทเดียวกัน = 409 ที่อ่านรู้เรื่อง ไม่ใช่ 500', async () => {
    const dept = await makeDepartment('บัญชี UBP', 'UBP');
    await createUser(
      base({ employee: { firstName: 'คนแรก', departmentId: dept, ownerCode: 77 } }) as never,
    );

    expect(
      createUser(
        base({ employee: { firstName: 'คนที่สอง', departmentId: dept, ownerCode: 77 } }) as never,
      ),
    ).rejects.toThrow(/OwnerCode/);
  });

  test('ผูกกับพนักงานที่มีอยู่ได้ตามเดิม', async () => {
    const employeeId = await makeEmployee({ departmentId });
    const created = await createUser(base({ employeeId }) as never);
    expect(created.employeeId).toBe(employeeId);
  });

  test('ไม่ผูกใครเลยก็ได้ (service account)', async () => {
    const created = await createUser(base() as never);
    expect(created.employeeId).toBeNull();
  });

  test('ส่งทั้ง employeeId และ employee พร้อมกัน = 400 ไม่ใช่เลือกให้เอง', async () => {
    const employeeId = await makeEmployee({ departmentId });
    expect(
      createUser(
        base({ employeeId, employee: { firstName: 'ซ้อน', departmentId } }) as never,
      ),
    ).rejects.toThrow(/เลือกได้อย่างเดียว/);
  });

  test('แผนกไม่มีจริง = 400 พร้อมบอก id ไม่ใช่ error ของ pg', async () => {
    expect(
      createUser(base({ employee: { firstName: 'ก', departmentId: 999999 } }) as never),
    ).rejects.toThrow(/ไม่พบแผนก/);
  });

  // ★ เคสที่เกิดขึ้นจริงบน DB จริง (2026-08-19) — แอดมินกรอกอีเมลของตัวเองที่มีแถว employee
  // อยู่แล้ว ได้ 500 "Internal server error" ซึ่งอ่านแล้วไม่รู้เลยว่าผิดตรงไหน
  // ต้องเป็น 409 ที่บอกว่าชนอะไรและให้ไปทำอะไรต่อ
  test('อีเมลซ้ำกับพนักงานที่มีอยู่ = 409 พร้อมบอกทางออก ไม่ใช่ 500', async () => {
    const email = 'somchai.k@example.com';
    await db.insert(employee).values({ firstName: 'คนเดิม', email, departmentId });

    expect(
      createUser(
        base({ employee: { firstName: 'คนใหม่', email, departmentId } }) as never,
      ),
    ).rejects.toThrow(/อีเมลนี้มีพนักงานคนอื่นใช้อยู่แล้ว/);
  });

  test('รหัสพนักงานซ้ำ = 409 ที่บอกว่าซ้ำที่ช่องไหน ไม่ใช่ข้อความรวม ๆ', async () => {
    const empId = '0010001';
    await db.insert(employee).values({ firstName: 'คนเดิม', empId, departmentId });

    expect(
      createUser(base({ employee: { firstName: 'คนใหม่', empId, departmentId } }) as never),
    ).rejects.toThrow(/รหัสพนักงานนี้ถูกใช้แล้ว/);
  });

  test('พนักงานที่มีบัญชีแล้ว ผูกซ้ำไม่ได้ = 409 ไม่ใช่ 500', async () => {
    const employeeId = await makeEmployee({ departmentId });
    await createUser(base({ employeeId }) as never);

    expect(createUser(base({ employeeId }) as never)).rejects.toThrow(/มีบัญชีผู้ใช้อยู่แล้ว/);
  });

  test('★ username ซ้ำ = ต้องไม่เหลือพนักงานผีค้าง (transaction ต้องย้อนจริง)', async () => {
    const username = 'u_ซ้ำ';
    await createUser(base({ username }) as never);

    const before = await db.select().from(employee);
    expect(
      createUser(
        base({ username, employee: { firstName: 'ผี', departmentId } }) as never,
      ),
    ).rejects.toThrow();

    const after = await db.select().from(employee);
    expect(after.length).toBe(before.length);
  });
});
