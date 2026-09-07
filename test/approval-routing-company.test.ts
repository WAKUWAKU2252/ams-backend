// ═══ ผู้อนุมัติต้องมาจาก "บริษัทของใบ PO" ไม่ใช่จากสังกัดของคน (0025) ═══
//
// บั๊กที่ไฟล์นี้เฝ้า: findApprovalTarget เคยไต่ ownerPrId -> employee.departmentId ตรง ๆ
// ซึ่งมีค่าเดียวต่อคน ขณะที่ department เป็นของบริษัทตั้งแต่ 0024 — คนที่ทำงานสองบริษัท
// (241 จาก 288 คนที่มีตัวตนใน SAP วัดเมื่อ 2026-09-02) จึงตอบได้แค่บริษัทเดียวเสมอ
// ผลจริงคือ PO ของ UBP/MIG วิ่งไปหาหัวหน้าฝั่ง UBA ทุกใบ = การ์ด Teams ไปหาคนผิด
//
// ★ เทสต์นี้ต้องล้มถ้ามีใครเปลี่ยน findApprovalTarget ให้ "ถอยไปใช้ employee.departmentId
//   เมื่อหาแถวใน employee_company ไม่เจอ" — การถอยแบบนั้นคือบั๊กเดิมทั้งดุ้น
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '@intrastucture/db';
import { asset, employeeCompany } from '@intrastucture/db/schema';
import { findApprovalTarget } from '@modules/business/purchase-order/purchase-order.service';
import {
  makeDepartment,
  makeLocation,
  makeEmployee,
  setDepartmentManager,
  resetDb,
  TEST_COMPANY,
} from './helpers/factory';

const OTHER_COMPANY = 'UBP';

beforeEach(resetDb);

/** คนหนึ่งคนที่มีตัวตนทั้งสองบริษัท คนละแผนก คนละหัวหน้า */
async function makeDualCompanyPerson() {
  const deptUba = await makeDepartment('จัดซื้อ', TEST_COMPANY);
  const deptUbp = await makeDepartment('จัดซื้อ', OTHER_COMPANY);

  const person = await makeEmployee({ departmentId: deptUba, ownerCode: 100 });
  // ตัวตนอีกใบของคนเดียวกัน — แผนกคนละแถว เพราะเป็นแผนกของอีกบริษัท
  await db
    .insert(employeeCompany)
    .values({ employeeId: person, companyCode: OTHER_COMPANY, ownerCode: 250, departmentId: deptUbp });

  const mgrUba = await makeEmployee({ departmentId: deptUba });
  const mgrUbp = await makeEmployee({ departmentId: deptUbp, companyCode: OTHER_COMPANY });
  await setDepartmentManager(deptUba, mgrUba);
  await setDepartmentManager(deptUbp, mgrUbp);

  return { person, deptUba, deptUbp, mgrUba, mgrUbp };
}

describe('ผู้อนุมัติถูกเลือกตามบริษัทของใบ ไม่ใช่ตามสังกัดของคน', () => {
  test('คนเดียวกัน สองบริษัท → ได้หัวหน้าคนละคนตามบริษัทของใบ', async () => {
    const { person, deptUba, deptUbp, mgrUba, mgrUbp } = await makeDualCompanyPerson();

    const uba = await findApprovalTarget(TEST_COMPANY, person);
    const ubp = await findApprovalTarget(OTHER_COMPANY, person);

    expect(uba.departmentId).toBe(deptUba);
    expect(uba.managerEmployeeId).toBe(mgrUba);
    // ★ หัวใจของเทสต์ — ก่อน 0025 บรรทัดนี้จะได้ mgrUba เพราะไต่จาก employee.departmentId
    expect(ubp.departmentId).toBe(deptUbp);
    expect(ubp.managerEmployeeId).toBe(mgrUbp);
    expect(ubp.managerEmployeeId).not.toBe(uba.managerEmployeeId);
  });

  test('ไม่มีตัวตนในบริษัทนั้น → ตอบว่าไม่รู้ ไม่ใช่ถอยไปใช้แผนกของบริษัทอื่น', async () => {
    const deptUba = await makeDepartment('บัญชี', TEST_COMPANY);
    const person = await makeEmployee({ departmentId: deptUba });
    const mgr = await makeEmployee({ departmentId: deptUba });
    await setDepartmentManager(deptUba, mgr);

    // คนนี้มีแถวเฉพาะของ UBA — ถามหาฝั่ง UBP ต้องได้ว่าง ไม่ใช่หัวหน้าของ UBA
    const ubp = await findApprovalTarget(OTHER_COMPANY, person);
    expect(ubp.departmentId).toBeNull();
    expect(ubp.managerEmployeeId).toBeNull();
  });

  test('มีตัวตนแต่ยังไม่ระบุแผนก (departmentId = NULL) → ตอบว่าไม่รู้', async () => {
    // ตรงกับสภาพจริงของ UBP หลัง backfill 0025: 21 คนที่ไม่มีข้อมูลแผนกมาให้
    const deptUba = await makeDepartment('คลัง', TEST_COMPANY);
    const person = await makeEmployee({ departmentId: deptUba });
    const mgr = await makeEmployee({ departmentId: deptUba });
    await setDepartmentManager(deptUba, mgr);
    await db
      .insert(employeeCompany)
      .values({ employeeId: person, companyCode: OTHER_COMPANY, ownerCode: 777, departmentId: null });

    const ubp = await findApprovalTarget(OTHER_COMPANY, person);
    expect(ubp.departmentId).toBeNull();
    expect(ubp.managerEmployeeId).toBeNull();
  });

  test('DB ปฏิเสธการผูกแผนกข้ามบริษัท — ไม่ต้องรอให้โค้ดจับ', async () => {
    const deptUba = await makeDepartment('ผลิต', TEST_COMPANY);
    const person = await makeEmployee({ departmentId: deptUba });

    // แถวของ UBP แต่ชี้แผนกของ UBA — composite FK ต้องปฏิเสธ
    //
    // ต้อง .execute() ให้เป็น Promise จริงก่อน: builder ของ drizzle เป็น thenable ที่ยังไม่
    // ยิงคิวรีจนกว่าจะถูก await — ส่งตัว builder เข้า expect().rejects ตรง ๆ จะไม่มีอะไรทำงาน
    // แล้วเทสต์ผ่านเพราะไม่ได้ทดสอบอะไรเลย (เจอมาแล้วตอนเขียนไฟล์นี้)
    await expect(
      db
        .insert(employeeCompany)
        .values({ employeeId: person, companyCode: OTHER_COMPANY, ownerCode: 501, departmentId: deptUba })
        .execute(),
    ).rejects.toThrow();
  });

  // ── สินทรัพย์ก็ผูกแผนกข้ามบริษัทไม่ได้เหมือนกัน (0026) ────────────────────
  //
  // เดิม fk_asset_department เป็นคีย์เดี่ยว ของ UBP จึงชี้แผนกของ UBA ได้เงียบ ๆ
  // ผลคือตารางสรุปรายแผนกบน dashboard ต้องเลือกระหว่าง "กรองบริษัทถูก" กับ
  // "ยอดกระทบกับ totals" อย่างใดอย่างหนึ่ง และรายงานรายแผนกจะนับของบริษัทอื่นปน
  test('asset ผูกแผนกของอีกบริษัทไม่ได้ — DB ปฏิเสธเอง', async () => {
    const deptUba = await makeDepartment('คลังกลาง', TEST_COMPANY);

    await expect(
      db
        .insert(asset)
        .values({
          origin: 'SAP_LEGACY',
          companyCode: OTHER_COMPANY, // ← ชิ้นของ UBP
          assetNumber: `X-${Date.now()}`,
          departmentId: deptUba, //       ← แต่ชี้แผนกของ UBA
          locationId: await makeLocation(),
        })
        .execute(),
    ).rejects.toThrow();
  });

  test('asset ที่ไม่ระบุแผนกยังบันทึกได้ (NULL ผ่านคีย์คู่ตามกติกา MATCH SIMPLE)', async () => {
    const [row] = await db
      .insert(asset)
      .values({
        origin: 'SAP_LEGACY',
        companyCode: OTHER_COMPANY,
        assetNumber: `Y-${Date.now()}`,
        departmentId: null,
        locationId: await makeLocation(),
      })
      .returning({ id: asset.id });

    expect(row!.id).toBeGreaterThan(0);
  });

  test('OwnerCode เลขเดียวกันคนละบริษัท = คนละคน', async () => {
    // ของจริง: OHEM ของ UBA กับ UBP เลขชนกัน 264 ตัว
    const a = await makeEmployee({ ownerCode: 42 });
    const deptUbp = await makeDepartment('ซ่อมบำรุง', OTHER_COMPANY);
    const b = await makeEmployee({ departmentId: deptUbp, companyCode: OTHER_COMPANY, ownerCode: 42 });

    expect(a).not.toBe(b);
    const rows = await db.select().from(employeeCompany);
    const uba = rows.find((r) => r.companyCode === TEST_COMPANY && r.ownerCode === 42);
    const ubp = rows.find((r) => r.companyCode === OTHER_COMPANY && r.ownerCode === 42);
    expect(uba?.employeeId).toBe(a);
    expect(ubp?.employeeId).toBe(b);
  });
});
