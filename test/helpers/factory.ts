// โรงงานสร้างข้อมูลตั้งต้นของเทสต์ — จงใจให้ "บาง" ที่สุดเท่าที่ constraint ยอม
// อะไรที่เทสต์ไม่ได้พูดถึงจะไม่ถูกเซ็ต เพื่อให้เวลาเทสต์ล้ม อ่านออกทันทีว่าล้มเพราะอะไร
import { eq, sql } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import {
  assetRequest,
  assetRequestLine,
  department,
  employee,
  employeeCompany,
  grpo,
  grpoLine,
  purchaseOrder,
  purchaseOrderItem,
  role,
  user,
} from '@intrastucture/db/schema';
import * as presence from '@modules/business/asset-request/presence.service';

/** ล้างทุกตารางแล้วรีเซ็ต serial — เรียกใน beforeEach ให้แต่ละเทสต์เริ่มจากศูนย์จริง ๆ */
export async function resetDb() {
  // lock อยู่ใน RAM ไม่ใช่ DB — TRUNCATE ไม่แตะมัน ต้องล้างเองไม่งั้นห้องของเทสต์ก่อนหน้า
  // ค้างมาชนกับ requestId ที่เริ่มนับใหม่จาก 1
  presence.resetRooms();
  // company ไม่ถูกล้าง (0021) — เป็นข้อมูลอ้างอิงที่ migration 0021 seed ไว้ ไม่ใช่ของเทสต์
  // ล้างแล้วทุก FK ที่ชี้มา (purchase_order/grpo/asset/employee/sync) จะ insert ไม่ได้เลย
  // และการ seed ใหม่เองในเทสต์คือการทำสำเนากติกาไว้สองที่ซึ่งจะเพี้ยนจาก migration วันหลัง
  const rows = await db.execute<{ tablename: string }>(sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('__drizzle_migrations', 'company')
  `);
  const names = rows.rows.map((r) => `"${r.tablename}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${names} RESTART IDENTITY CASCADE`));
}

const uniq = () => crypto.randomUUID().slice(0, 8);

/**
 * companyCode รับเข้ามาได้ตั้งแต่ 0024 — แผนกเป็นของบริษัทแล้ว ไม่ใช่ของกลาง
 * ค่าเริ่มต้นเป็น TEST_COMPANY เพื่อให้เทสต์เดิมที่เรียก makeDepartment() เปล่า ๆ ไม่ต้องแก้
 * (TEST_COMPANY ประกาศอยู่ใต้ไฟล์ อ่านตอนถูกเรียกซึ่งเป็นหลัง module init เสมอ)
 */
export async function makeDepartment(
  name = `แผนก ${uniq()}`,
  companyCode: string = TEST_COMPANY,
): Promise<number> {
  const [d] = await db.insert(department).values({ name, companyCode }).returning();
  return d!.id;
}

/**
 * พนักงานหนึ่งคน + ตัวตนในบริษัทหนึ่งบริษัท (employee_company)
 *
 * ★ สร้างแถว employee_company ให้เสมอตั้งแต่ 0025 — เส้นทางหาผู้อนุมัติอ่านจากตารางนั้น
 *   ที่เดียวแล้ว ไม่ได้อ่าน employee.departmentId อีก เทสต์ที่ไม่มีแถวนี้จะหาหัวหน้าไม่เจอ
 *   ทั้งที่ตั้งใจให้เจอ (ดู findApprovalTarget)
 *
 * ownerCode ใส่ให้เมื่อระบุเท่านั้น — ปล่อย NULL คือ "คนที่ยังไม่มีตัวตนใน OHEM"
 * ซึ่งเปิด PO ไม่ได้ แต่ยังเป็นหัวหน้าแผนก/ผู้ถือครองสินทรัพย์ได้ตามปกติ
 */
export async function makeEmployee(
  opts: {
    departmentId?: number;
    email?: string | null;
    companyCode?: string;
    ownerCode?: number;
  } = {},
): Promise<number> {
  const companyCode = opts.companyCode ?? TEST_COMPANY;
  const departmentId = opts.departmentId ?? (await makeDepartment(undefined, companyCode));
  const [e] = await db
    .insert(employee)
    .values({
      firstName: 'ทดสอบ',
      lastName: uniq(),
      firstNameEn: 'Test',
      lastNameEn: 'User',
      email: opts.email ?? null,
      departmentId,
    })
    .returning();
  await db.insert(employeeCompany).values({
    employeeId: e!.id,
    companyCode,
    ownerCode: opts.ownerCode ?? null,
    departmentId,
  });
  return e!.id;
}

export async function setDepartmentManager(departmentId: number, employeeId: number) {
  await db.update(department).set({ managerId: employeeId }).where(eq(department.id, departmentId));
}

export async function makeUser(
  opts: { displayName?: string; roleName?: string; employeeId?: number } = {},
): Promise<number> {
  // role ชื่อซ้ำไม่ได้ (uq_role_name) — เทสต์ที่ขอ role เดิมซ้ำจึงต้องใช้แถวเดิม
  const roleName = opts.roleName ?? `ROLE_${uniq()}`;
  const existing = await db.query.role.findFirst({ where: eq(role.name, roleName) });
  const roleId =
    existing?.id ?? (await db.insert(role).values({ name: roleName }).returning())[0]!.id;

  const [u] = await db
    .insert(user)
    .values({
      username: `u_${uniq()}`,
      displayName: opts.displayName ?? 'ผู้ทดสอบ',
      roleId,
      employeeId: opts.employeeId,
    })
    .returning();
  return u!.id;
}

/**
 * ชุดหัวหน้าที่ resolveApprovalTarget ต้องการครบทั้งสาย:
 * ผู้ขอซื้อ (OwnerPR) -> แผนก -> หัวหน้าแผนก (employee) -> บัญชีผู้ใช้ role MANAGER + มีอีเมล
 */
export async function makeApprovalChain(opts: { managerEmail?: string | null } = {}) {
  const departmentId = await makeDepartment();
  const ownerPrId = await makeEmployee({ departmentId });
  const managerEmployeeId = await makeEmployee({
    departmentId,
    // อีเมลต้องไม่ซ้ำ (uq_employee_email) — เทสต์ที่สร้างหลายสายในเทสต์เดียวจะชนกันทันที
    email: opts.managerEmail === undefined ? `manager-${uniq()}@example.com` : opts.managerEmail,
  });
  await setDepartmentManager(departmentId, managerEmployeeId);
  const managerUserId = await makeUser({
    roleName: 'MANAGER',
    employeeId: managerEmployeeId,
    displayName: 'หัวหน้าทดสอบ',
  });
  return { departmentId, ownerPrId, managerEmployeeId, managerUserId };
}

export interface PoItemSpec {
  poLine: number;
  quantity: number;
  unitPrice: number;
  /** ไม่ระบุ = quantity * unitPrice */
  lineTotal?: number;
  description?: string;
}

/**
 * บริษัทที่เทสต์ใช้เป็นค่าตั้งต้น — migration 0021 seed 7 บริษัทไว้แล้ว จึงมีแถวนี้แน่นอน
 * เทสต์ที่ต้องพิสูจน์เรื่องข้ามบริษัทให้ส่ง companyCode เข้ามาเองเป็น 'UBP'
 */
export const TEST_COMPANY = 'UBA';


/** PO 1 ใบ + บรรทัดตามที่ระบุ — คืน id ของแต่ละบรรทัดเรียงตามที่ส่งเข้ามา */
export async function makePo(
  poNumber: string,
  items: PoItemSpec[],
  opts: { ownerPrId?: number; companyCode?: string } = {},
) {
  const companyCode = opts.companyCode ?? TEST_COMPANY;
  await db
    .insert(purchaseOrder)
    .values({ poNumber, companyCode, vendorName: 'ผู้ขายทดสอบ', ownerPrId: opts.ownerPrId });
  const rows = await db
    .insert(purchaseOrderItem)
    .values(
      items.map((i) => ({
        poNumber,
        poLine: i.poLine,
        itemDescription: i.description ?? `สินค้า ${i.poLine}`,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal ?? i.quantity * i.unitPrice,
      })),
    )
    .returning();
  return { poNumber, itemIds: rows.map((r) => r.id) };
}

/** รอบรับของ 1 รอบ ที่รับของจาก PO line เดียว */
export async function makeGrpo(
  grpoNo: string,
  poItemId: string,
  receivedQty: number,
  companyCode: string = TEST_COMPANY,
) {
  const [g] = await db.insert(grpo).values({ grpoNo, companyCode, grpoDate: '2026-08-01' }).returning();
  const [l] = await db.insert(grpoLine).values({ grpoId: g!.id, poItemId, receivedQty }).returning();
  return { grpoId: g!.id, grpoLineId: l!.id, grpoNo };
}

export async function makeRequest(
  poNumber: string,
  createdBy: number,
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' = 'DRAFT',
): Promise<number> {
  const [r] = await db.insert(assetRequest).values({ poNumber, createdBy, status }).returning();
  return r!.id;
}

/**
 * ให้ user คนนี้เป็นผู้ถือ lock ขั้นบัญชีของใบนั้น — ปุ่มของบัญชีทุกปุ่มบังคับไว้แล้ว
 * (assertRegistrationHolder) เทสต์ที่ทดสอบ "กติกาของปุ่ม" จึงต้องหยิบ lock ก่อนเสมอ
 *
 * ล้างห้องก่อนทุกครั้ง เพราะเทสต์หนึ่งมักสลับบทบาทกันทำ (ผู้ขอลงชิ้น → บัญชีออกเลข/ตีกลับ)
 * ถ้าไม่ล้าง คนที่สองจะกลายเป็นคนต่อคิวแทนที่จะได้ lock แล้วเทสต์จะล้มด้วยเหตุผลที่ไม่ได้ทดสอบ
 * (กติกา lock จริง ๆ ทดสอบแยกไว้ที่ presence-lock.test.ts)
 */
export function holdRegistration(requestId: number, userId: number): void {
  presence.resetRooms();
  presence.subscribe('registration', requestId, { id: userId, name: 'เทสต์' }, () => {});
}

/** แจ้งจำนวนเองของรอบหนึ่ง (ข้าม presence lock — ที่นี่เทสต์กติกาเพดาน ไม่ใช่กติกา lock) */
export async function declare(
  requestId: number,
  grpoLineId: string,
  declaredQty: number,
  userId: number,
) {
  await db.insert(assetRequestLine).values({
    requestId,
    grpoLineId,
    declaredQty,
    reason: 'ทดสอบ',
    createdBy: userId,
    updatedBy: userId,
  });
}

/** ชิ้นที่ยังไม่ถูกลบของ PO line หนึ่ง เรียงตาม unitNo — ตัวช่วยอ่านผลลัพธ์ในเทสต์ */
export async function assetsOfPoItem(poItemId: string) {
  return db.query.asset.findMany({
    where: (a, { and, eq: e, isNull }) => and(e(a.poItemId, poItemId), isNull(a.deletedAt)),
    orderBy: (a, { asc }) => [asc(a.unitNo)],
  });
}

/** สถานที่ตั้ง 1 แห่ง — createAssetBody บังคับ locationId เสมอ */
export async function makeLocation(code = `LOC-${uniq()}`): Promise<number> {
  const { assetLocation } = await import('@intrastucture/db/schema');
  const [l] = await db
    .insert(assetLocation)
    .values({ code, name: `สถานที่ ${code}` })
    .returning();
  return l!.id;
}

/**
 * "ตึก" ของผัง — asset_location ที่ติดธง isPlanArea (0023)
 *
 * แยก helper จาก makeLocation เพราะสองอย่างนี้คนละชนิดกันตั้งแต่ 0022: ตัวนี้มีไว้ให้ห้อง
 * ห้อยเท่านั้น ห้ามโผล่ใน dropdown บัญชีและใส่เป็น asset.locationId ไม่ได้
 */
export async function makePlanArea(code = `BLD-${uniq()}`): Promise<number> {
  const { assetLocation } = await import('@intrastucture/db/schema');
  const [l] = await db
    .insert(assetLocation)
    .values({ code, name: `ตึก ${code}`, isPlanArea: true })
    .returning();
  return l!.id;
}

/** ห้องบนผัง — ต้องมี planKey + polygon ถึงจะโผล่ใน /master/floor-plans */
export async function makeSubLocation(
  locationId: number,
  opts: { floor?: string; room?: string; planKey?: string } = {},
): Promise<number> {
  const { assetSubLocation } = await import('@intrastucture/db/schema');
  const [s] = await db
    .insert(assetSubLocation)
    .values({
      code: `ROOM-${uniq()}`,
      locationId,
      floor: opts.floor ?? '1',
      room: opts.room ?? `ห้อง ${uniq()}`,
      planKey: opts.planKey ?? 'floor-1',
      polygon: [
        [0.1, 0.1],
        [0.3, 0.1],
        [0.3, 0.3],
        [0.1, 0.3],
      ],
    })
    .returning();
  return s!.id;
}

/** เปลี่ยนสถานะใบตรง ๆ — ใช้จำลอง "ใบรอบก่อนที่ปิดไปแล้ว" โดยไม่ต้องเดินทั้ง flow */
export async function setRequestStatus(
  requestId: number,
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED',
) {
  await db.update(assetRequest).set({ status }).where(eq(assetRequest.id, requestId));
}
