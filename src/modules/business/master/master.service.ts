import { and, asc, count, eq, ilike, or, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { db } from '@intrastucture/db';
import {
  assetLocation,
  assetSubLocation,
  category,
  department,
  employee,
} from '@intrastucture/db/schema';
import { paginate, type Paginated } from '@common/pagination';
import { requireScalar } from '@common/db-result';
import type {
  DepartmentOption,
  EmployeeListInput,
  EmployeeOption,
  EmployeeRow,
  MasterListInput,
  MasterOption,
  SubLocationOption,
  SubLocationRow,
} from './master.types';

/**
 * เงื่อนไข isActive ที่ใช้ร่วมทุกตาราง
 *
 * ค่าตั้งต้นคือเอาเฉพาะแถวที่เปิดใช้ — ตาราง master ใช้ isActive แทนการลบ เพราะแถวที่
 * ถูก asset อ้างถึงแล้วลบจริงไม่ได้ (FK กันอยู่) ถ้าไม่กรอง แผนกที่ยุบไปแล้วหรือพนักงาน
 * ที่ลาออกจะยังโผล่ใน dropdown แล้วคนกรอกจะผูก asset เข้ากับของที่เลิกใช้โดยไม่รู้ตัว
 */
function activeFilter(column: AnyPgColumn, includeInactive?: boolean): SQL | undefined {
  return includeInactive ? undefined : eq(column, true);
}

// ── department ─────────────────────────────────────────────────────────────

export async function findDepartments(input: MasterListInput = {}): Promise<DepartmentOption[]> {
  const search = input.search?.trim();

  return db
    .select({
      id: department.id,
      name: department.name,
      shortName: department.shortName,
      departmentId: department.departmentId,
    })
    .from(department)
    .where(
      and(
        activeFilter(department.isActive, input.includeInactive),
        search ? ilike(department.name, `%${search}%`) : undefined,
      ),
    )
    // เรียงตามชื่อไม่ใช่ id — Postgres ไม่การันตีลำดับแถวเมื่อไม่สั่ง ORDER BY
    // ลำดับจะสลับเองหลัง VACUUM หรือหลัง import รอบใหม่ แล้วคนที่ชินตำแหน่งจะเลือกผิด
    .orderBy(asc(department.name));
}

// ── category ───────────────────────────────────────────────────────────────

export async function findCategories(input: MasterListInput = {}): Promise<MasterOption[]> {
  const search = input.search?.trim();

  return db
    .select({ id: category.id, name: category.name })
    .from(category)
    .where(
      and(
        activeFilter(category.isActive, input.includeInactive),
        search ? ilike(category.name, `%${search}%`) : undefined,
      ),
    )
    .orderBy(asc(category.name));
}

// findUoms ถูกถอดใน 0011 พร้อมตาราง uom — หน่วยนับเป็นคอลัมน์ asset.uom ที่ sync มาจาก SAP
// ไม่ใช่ master ที่ผู้ใช้เลือก จึงไม่มี endpoint ให้ดึงรายการอีก (ดูเหตุผลเต็มที่ master.ts)

// ── asset location / sub location ──────────────────────────────────────────

export async function findLocations(input: MasterListInput = {}): Promise<MasterOption[]> {
  const search = input.search?.trim();

  return db
    .select({ id: assetLocation.id, name: assetLocation.name })
    .from(assetLocation)
    .where(
      and(
        activeFilter(assetLocation.isActive, input.includeInactive),
        search ? ilike(assetLocation.name, `%${search}%`) : undefined,
      ),
    )
    .orderBy(asc(assetLocation.name));
}

/**
 * ชื่อที่โชว์ใน dropdown — ตารางเก็บ floor กับ room แยกกันและ nullable ทั้งคู่
 *
 * export ไว้ให้ asset.service ใช้ตอนประกอบสถานที่ในใบแจ้งขออนุมัติด้วย — ต้องเป็นสูตร
 * เดียวกับ dropdown ไม่งั้นผู้ใช้เลือก "ชั้น 2 / ห้อง 201" แต่ผู้อนุมัติเห็นคนละข้อความ
 *
 * ต่อสตริงตรง ๆ จะได้ตัวเลือกว่างเปล่าหรือขึ้นต้นด้วย " / " เมื่อมีแค่ช่องเดียว
 * แถวที่ไม่มีทั้งคู่เกิดได้จริง (unique เป็น NULLS NOT DISTINCT จึงมีได้แถวเดียวต่อสถานที่)
 * — ใช้ remark เป็นทางถอย ไม่มีอีกค่อยใช้ id เพื่อให้ยังแยกออกว่าเป็นตัวไหน
 */
export function subLocationName(row: Pick<SubLocationRow, 'id' | 'floor' | 'room' | 'remark'>): string {
  const parts = [
    row.floor ? `ชั้น ${row.floor}` : null,
    row.room ? `ห้อง ${row.room}` : null,
  ].filter(Boolean);

  if (parts.length) return parts.join(' / ');
  return row.remark?.trim() || `ตำแหน่งย่อย #${row.id}`;
}

export async function findSubLocations(input: MasterListInput = {}): Promise<SubLocationOption[]> {
  const search = input.search?.trim();

  // ไม่กรองตาม locationId ที่ service — คืนครบแล้วให้ frontend กรองเอง (มีหลักสิบแถว)
  // ผู้ใช้สลับสถานที่ไปมาระหว่างกรอกฟอร์มจะได้ไม่ต้องยิง API ใหม่ทุกครั้งที่เปลี่ยน
  const rows = await db
    .select({
      id: assetSubLocation.id,
      locationId: assetSubLocation.locationId,
      floor: assetSubLocation.floor,
      room: assetSubLocation.room,
      remark: assetSubLocation.remark,
    })
    .from(assetSubLocation)
    .where(
      and(
        activeFilter(assetSubLocation.isActive, input.includeInactive),
        search
          ? or(ilike(assetSubLocation.floor, `%${search}%`), ilike(assetSubLocation.room, `%${search}%`))
          : undefined,
      ),
    )
    // เรียงที่ DB ตามคอลัมน์จริง — เรียงตามชื่อที่ประกอบแล้วทำที่นี่ไม่ได้ (เป็นค่าที่คำนวณฝั่ง JS)
    // ปิดท้ายด้วย id เพราะ floor/room ซ้ำกันได้ข้ามสถานที่ ถ้าไม่มี tiebreaker ลำดับจะสลับเอง
    .orderBy(asc(assetSubLocation.locationId), asc(assetSubLocation.floor), asc(assetSubLocation.room), asc(assetSubLocation.id));

  return rows.map(
    (r): SubLocationOption => ({ id: r.id, name: subLocationName(r), locationId: r.locationId }),
  );
}

// ── employee ───────────────────────────────────────────────────────────────

/**
 * ชื่อที่จะโชว์ใน dropdown — ไทยก่อน ไม่มีค่อยตกไปอังกฤษ ไม่มีทั้งคู่ใช้รหัสพนักงาน
 *
 * export ออกไปให้ asset.service ใช้ตัวเดียวกัน (เหตุผลเดียวกับ subLocationName): คนละสูตร
 * เมื่อไหร่ ชื่อผู้ถือครองในตาราง/กล่องจัดการจะไม่ตรงกับที่ผู้ใช้เลือกไว้ใน dropdown
 *
 * ทุกคอลัมน์ชื่อเป็น nullable (ข้อมูลมาจาก HR ซึ่งไม่ได้กรอกครบทุกคน) — ถ้าต่อสตริงตรง ๆ
 * จะได้ตัวเลือกว่างเปล่าที่ผู้ใช้แยกไม่ออกว่าเป็นใคร
 */
export function employeeName(row: Pick<EmployeeRow, 'firstName' | 'lastName' | 'firstNameEn' | 'lastNameEn' | 'empId'>): string {
  const th = [row.firstName, row.lastName].filter(Boolean).join(' ').trim();
  if (th) return th;

  const en = [row.firstNameEn, row.lastNameEn].filter(Boolean).join(' ').trim();
  if (en) return en;

  return row.empId ?? `พนักงาน (ไม่มีชื่อในระบบ)`;
}

/**
 * ชื่อคนสำหรับ "เอกสารและการแจ้งเตือนที่ออกนอกระบบ" (การ์ด Teams / อีเมล) — firstName + lastName เสมอ
 *
 * ห้ามใช้ user.displayName ในเอกสาร: มันคือชื่อบัญชี ตั้งเองได้ ซ้ำกันได้ และหลายคนตั้งเป็น
 * ชื่อเล่น/username ซึ่งคนอ่านนอกทีมไม่รู้ว่าเป็นใคร ส่วนชื่อพนักงานมาจาก HR ตรงกับเอกสารอื่น
 *
 * สูตรชื่อใช้ employeeName() ตัวเดียวกับ dropdown (ไทย → อังกฤษ → รหัสพนักงาน) — คนละสูตร
 * เมื่อไหร่ ชื่อในเอกสารจะไม่ตรงกับชื่อที่ผู้ใช้เห็นในระบบ
 *
 * displayName เหลือเป็นทางหนีสุดท้ายเฉพาะบัญชีที่ยังไม่ผูกกับพนักงาน (user.employeeId = NULL)
 */
export function documentPersonName(
  row:
    | (Partial<Pick<EmployeeRow, 'firstName' | 'lastName' | 'firstNameEn' | 'lastNameEn' | 'empId'>> & {
        displayName?: string | null;
      })
    | null
    | undefined,
): string {
  if (!row) return '-';
  const linked = row.firstName || row.lastName || row.firstNameEn || row.lastNameEn || row.empId;
  if (linked) {
    return employeeName({
      firstName: row.firstName ?? null,
      lastName: row.lastName ?? null,
      firstNameEn: row.firstNameEn ?? null,
      lastNameEn: row.lastNameEn ?? null,
      empId: row.empId ?? null,
    });
  }
  return row.displayName?.trim() || '-';
}

/**
 * แบ่งหน้าเพราะ UI เป็นลิสต์ให้เลื่อนดูพร้อมพิมพ์ค้น ไม่ใช่ dropdown สั้น ๆ แบบ master ตัวอื่น
 * (คืนทั้งบริษัทในก้อนเดียวไม่ไหว และการบังคับให้พิมพ์ค้นก่อนก็ปิดทางคนที่อยากเลื่อนหา)
 */
export async function findEmployees(input: EmployeeListInput): Promise<Paginated<EmployeeOption>> {
  const { page, limit } = input;
  const search = input.search?.trim();

  // ค้นได้ทั้งชื่อไทย/อังกฤษ/รหัสพนักงาน — คนค้นจำได้ไม่เหมือนกัน
  const searchFilter: SQL | undefined = search
    ? or(
        ilike(employee.firstName, `%${search}%`),
        ilike(employee.lastName, `%${search}%`),
        ilike(employee.firstNameEn, `%${search}%`),
        ilike(employee.lastNameEn, `%${search}%`),
        ilike(employee.empId, `%${search}%`),
      )
    : undefined;

  const where = and(
    activeFilter(employee.isActive, input.includeInactive),
    input.departmentId ? eq(employee.departmentId, input.departmentId) : undefined,
    // ระบุ id = ขอคนเดียวเจาะจง (ฟอร์มแก้ไขแปลง employeeId เป็นชื่อ) — ตัวกรองอื่นยังใช้ร่วมได้
    input.id ? eq(employee.id, input.id) : undefined,
    searchFilter,
  );

  // นับกับดึงพร้อมกัน — total ต้องเป็นยอดของ "ทั้งชุดที่กรองแล้ว" ไม่ใช่จำนวนแถวในหน้านี้
  const [rows, totalResult] = await Promise.all([
    db
      .select({
        id: employee.id,
        firstName: employee.firstName,
        lastName: employee.lastName,
        firstNameEn: employee.firstNameEn,
        lastNameEn: employee.lastNameEn,
        empId: employee.empId,
        departmentId: employee.departmentId,
      })
      .from(employee)
      .where(where)
      // ต้องมี tiebreaker ที่ unique ปิดท้าย — ชื่อซ้ำกันได้ ถ้าไม่มี id ปิดท้าย
      // แถวที่ชื่อเท่ากันจะสลับตำแหน่งข้ามหน้า แล้วผู้ใช้จะเห็นคนเดิมซ้ำ/หายไปเลย
      .orderBy(asc(employee.firstName), asc(employee.lastName), asc(employee.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db.select({ value: count() }).from(employee).where(where),
  ]);

  // ประกอบชื่อฝั่งนี้ ไม่ใช่ฝั่ง frontend — กติกาการ fallback ไทย/อังกฤษ/รหัส ต้องเหมือนกัน
  // ทุกหน้าที่โชว์ชื่อพนักงาน ปล่อยให้แต่ละหน้าประกอบเองแล้วจะเพี้ยนคนละแบบ
  const data = rows.map(
    (r): EmployeeOption => ({
      id: r.id,
      name: employeeName(r),
      departmentId: r.departmentId,
      empId: r.empId,
    }),
  );

  return paginate(data, requireScalar(totalResult, 'count employee'), page, limit);
}
