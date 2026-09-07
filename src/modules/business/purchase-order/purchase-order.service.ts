import { and, count, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { purchaseOrder, purchaseOrderItem, grpoLine, asset } from '@intrastucture/db/schema';
import { NotFoundError } from '@common/errors';
import { paginate } from '@common/pagination';
import { requireScalar } from '@common/db-result';
import { APPROVER_ROLE_LIST } from '@common/roles';
import { employee, employeeCompany, role, user } from '@intrastucture/db/schema';
import type {
  FindPageParams,
  LineTotals,
  ReceivedStatus,
  RegistrationStatus,
} from './purchase-order.types';

// ชนิดสองตัวนี้เคยประกาศในไฟล์นี้ — ย้ายไป purchase-order.types.ts แล้ว
// re-export ไว้เพราะโมดูลอื่นเคย import จากที่นี่
export type { ReceivedStatus, RegistrationStatus } from './purchase-order.types';

// with นี้ inline ในแต่ละ query (ไม่แยกเป็น const) เพราะ Drizzle infer type ของ callback
// ได้เฉพาะตอนส่งตรงเข้า query — nested orderBy ล็อกลำดับให้ deterministic:
// items เรียงตาม poLine, grpoLines ตามลำดับรอบรับของ (ไม่ระบุ = ลำดับตาม query planner ไม่แน่นอน)

/**
 * "รับครบหรือยัง" — คำนวณสดทุกครั้ง ไม่เก็บเป็นคอลัมน์
 *   none    ยังไม่มีการรับของเลย
 *   partial รับมาบ้างแล้วแต่ยังไม่ครบทุก line
 *   full    ทุก line รับครบตามจำนวนที่สั่ง
 * ครบทั้งใบต้องครบ "ทุก line" — ดูผลรวมอย่างเดียวไม่พอ เพราะ line หนึ่งรับเกิน
 * อีก line ขาด แล้วผลรวมบังเอิญเท่ากันได้ (เคสรับผิด line ซึ่งเกิดจริง)
 */
function toReceivedStatus(lines: { ordered: number; received: number }[]): ReceivedStatus {
  if (lines.length === 0) return 'none';
  if (lines.every((l) => l.received === 0)) return 'none';
  return lines.every((l) => l.received >= l.ordered) ? 'full' : 'partial';
}

/**
 * "ลงทะเบียนสินทรัพย์ไปแล้วแค่ไหน" — คนละคำถามกับ receivedStatus
 *   Warehouse ถาม "ของมาครบไหม"     -> receivedStatus
 *   คนทำทะเบียนถาม "ลงไปแล้วแค่ไหน"  -> registrationStatus
 *
 * นับทุกบรรทัด — ระบบไม่ตัดสินเองว่าอะไรควรขึ้นทะเบียน บัญชีเป็นผู้ตรวจตอนอนุมัติ
 * (ค่าเช่า cloud/license ราคาสูงแต่เป็นค่าใช้จ่าย — เกณฑ์อัตโนมัติตัดสินผิดได้)
 */
function toRegistrationStatus(lines: { ordered: number; registered: number }[]): RegistrationStatus {
  if (lines.length === 0) return 'none';
  if (lines.every((l) => l.registered === 0)) return 'none';
  return lines.every((l) => l.registered >= l.ordered) ? 'full' : 'partial';
}

/**
 * ยอดรับ + ยอดที่ลงทะเบียนแล้ว ต่อ line ของ PO ที่ระบุ
 * query เดียวครอบทุกใบ กัน N+1 ตอนทำหน้า list
 *
 * แยกสอง aggregate ไม่ join รวมทีเดียว: join grpo_line แล้ว join asset ต่อ จะทำให้แถวคูณกัน
 * (line มี 2 GRPO x asset 3 ชิ้น = 6 แถว) แล้ว sum(receivedQty) จะบวกซ้ำเป็นเท่าตัว
 */
async function totalsByPo(poNumbers: string[]) {
  const map = new Map<string, LineTotals[]>();
  if (poNumbers.length === 0) return map;

  const [received, registered] = await Promise.all([
    db
      .select({
        poNumber: purchaseOrderItem.poNumber,
        itemId: purchaseOrderItem.id,
        ordered: purchaseOrderItem.quantity,
        unitPrice: purchaseOrderItem.unitPrice,
        // left join แล้ว sum ได้ NULL เมื่อ line นั้นยังไม่เคยมี GRPO — coalesce เป็น 0
        // float8 ไม่ใช่ int: receivedQty เป็น numeric แล้ว ::int จะปัดทิ้งเศษเงียบ ๆ
        // และถ้าไม่ cast เลย node-postgres จะคืน numeric มาเป็น string ไม่ใช่ number
        received: sql<number>`coalesce(sum(${grpoLine.receivedQty}), 0)::float8`,
      })
      .from(purchaseOrderItem)
      .leftJoin(grpoLine, eq(grpoLine.poItemId, purchaseOrderItem.id))
      .where(inArray(purchaseOrderItem.poNumber, poNumbers))
      .groupBy(purchaseOrderItem.id),
    db
      .select({
        itemId: grpoLine.poItemId,
        registered: count(asset.id),
      })
      .from(grpoLine)
      .innerJoin(asset, and(eq(asset.grpoLineId, grpoLine.id), isNull(asset.deletedAt)))
      .innerJoin(purchaseOrderItem, eq(purchaseOrderItem.id, grpoLine.poItemId))
      .where(inArray(purchaseOrderItem.poNumber, poNumbers))
      .groupBy(grpoLine.poItemId),
  ]);

  const regByItem = new Map(registered.map((r) => [r.itemId, r.registered]));
  for (const r of received) {
    const list = map.get(r.poNumber) ?? [];
    list.push({
      ordered: r.ordered,
      unitPrice: r.unitPrice,
      received: r.received,
      registered: regByItem.get(r.itemId) ?? 0,
    });
    map.set(r.poNumber, list);
  }
  return map;
}

/** จำนวน asset ที่ลงทะเบียนแล้ว แยกตาม po_item — key เป็น itemId ตรง ๆ ไม่พึ่งลำดับแถว */
async function registeredByItem(poNumbers: string[]) {
  if (poNumbers.length === 0) return new Map<string, number>();

  const rows = await db
    .select({ itemId: grpoLine.poItemId, registered: count(asset.id) })
    .from(grpoLine)
    .innerJoin(asset, and(eq(asset.grpoLineId, grpoLine.id), isNull(asset.deletedAt)))
    .innerJoin(purchaseOrderItem, eq(purchaseOrderItem.id, grpoLine.poItemId))
    .where(inArray(purchaseOrderItem.poNumber, poNumbers))
    .groupBy(grpoLine.poItemId);

  return new Map(rows.map((r) => [r.itemId, r.registered]));
}

/** เติม ordered/received/registered ต่อ line ให้ frontend ไม่ต้องบวก grpoLines เอง */
function withLineTotals<
  T extends { id: string; quantity: number; unitPrice: number; grpoLines: { receivedQty: number }[] },
>(item: T, registered: Map<string, number>) {
  const received = item.grpoLines.reduce((sum, l) => sum + l.receivedQty, 0);
  return {
    ...item,
    ordered: item.quantity,
    received,
    registered: registered.get(item.id) ?? 0,
    isFullyReceived: received >= item.quantity,
  };
}

export async function findAll() {
  const rows = await db.query.purchaseOrder.findMany({
    with: {
      items: {
        orderBy: (item, { asc }) => [asc(item.poLine)],
        // grpoNo/grpoDate ย้ายขึ้นไปอยู่ตาราง grpo แล้ว ต้องพ่วงมาด้วยเพราะหน้าฟอร์มแสดง
        // เลข GRPO ต่อชิ้น — เรียงตาม grpoId (serial) = เรียงตามลำดับรอบรับของอยู่แล้ว
        with: { grpoLines: { with: { grpo: true }, orderBy: (line, { asc }) => [asc(line.grpoId)] } },
      },
    },
    orderBy: (po, { desc }) => [desc(po.poDate)],
  });

  const registered = await registeredByItem(rows.map((r) => r.poNumber));
  return rows.map((po) => {
    const items = po.items.map((item) => withLineTotals(item, registered));
    return {
      ...po,
      items,
      receivedStatus: toReceivedStatus(items),
      registrationStatus: toRegistrationStatus(items),
    };
  });
}

/**
 * ปลายทางการอนุมัติของ PO ใบหนึ่ง — หัวหน้าของผู้ขอซื้อ (OwnerPR)
 *
 * ไต่สี่ต่อ: ownerPrId -> employee.departmentId -> department.managerId -> user
 * ทุกช่วงขาดได้จริง (PO เก่าไม่มี OwnerPR / แผนกยังไม่ตั้งหัวหน้า / หัวหน้าไม่มีบัญชี AMS)
 * จึงคืน null ทีละช่องแทนที่จะโยน — คนเรียกตัดสินเองว่าขาดช่องไหนแล้วต้องทำอะไร
 * (หน้าแสดง PO แค่โชว์ว่างไว้ได้ แต่ตอน submit ต้องครบถึงจะส่งได้)
 *
 * managerUserId บังคับ role ที่อนุมัติได้ด้วย (APPROVER_ROLES) ให้ผลเท่ากับ requireRole(...)
 * ที่กั้น POST /asset-requests/:id/approve — ไม่งั้นจะ route ไปหาคนที่กดอนุมัติไม่ได้อยู่ดี
 */
export type PoApprovalTarget = {
  departmentId: number | null;
  departmentName: string |null
  /** employee.id ของหัวหน้า — ตัวที่ส่งไปกับใบแล้ว Teams เด้งกลับมาเป็น approvedBy */
  managerEmployeeId: number | null;
  /** user.id ของหัวหน้า — ตัวที่ลง asset_request.assignedManagerId (FK ชี้ user ไม่ใช่ employee) */
  managerUserId: number | null;
  managerFirstName: string | null;
  managerLastName: string | null;
  // ชื่ออังกฤษ + รหัสพนักงานมาด้วย เพราะชื่อบนการ์ด Teams ใช้สูตรเดียวกับที่อื่นทั้งระบบ
  // (documentPersonName: ไทย → อังกฤษ → รหัส) — ข้อมูล HR ไม่ได้กรอกชื่อไทยครบทุกคน
  // ไม่ได้ส่งออก API: findById ยังคืนแค่ managerFirstName/managerLastName เหมือนเดิม
  managerFirstNameEn: string | null;
  managerLastNameEn: string | null;
  managerEmpId: string | null;
  managerEmail: string | null;
};

const NO_APPROVAL_TARGET: PoApprovalTarget = {
  departmentId: null,
  departmentName:null,
  managerEmployeeId: null,
  managerUserId: null,
  managerFirstName: null,
  managerLastName: null,
  managerFirstNameEn: null,
  managerLastNameEn: null,
  managerEmpId: null,
  managerEmail: null,
};

export async function findApprovalTarget(
  companyCode: string,
  ownerPrId: number | null,
): Promise<PoApprovalTarget> {
  if (!ownerPrId) return NO_APPROVAL_TARGET;

  // ── แผนกต้องมาจาก "บริษัทของใบ PO" ไม่ใช่จากตัวคน (0025) ────────────────────
  //
  // เดิมอ่าน employee.departmentId ซึ่งมีค่าเดียวต่อคน แต่ department เป็นของบริษัท (0024)
  // — วัดจริงพบว่า 241 จาก 288 คนที่มีตัวตนใน SAP อยู่สองบริษัท และทุกคนผูกกับแผนกของ UBA
  // ผลคือ PO ของ UBP/MIG ไต่ไปจบที่หัวหน้าฝั่ง UBA เสมอ = การ์ดขออนุมัติไปหาคนผิด
  //
  // ★ ไม่มีแถว หรือมีแถวแต่ departmentId ว่าง → ตอบ "ไม่รู้" **ห้ามถอยไปใช้
  //   employee.departmentId** การถอยคือการกลับไปเป็นบั๊กเดิมแบบเงียบ ๆ ทันที
  //   ปลายทางของ "ไม่รู้" คือ submitRequest โยน ConflictError ให้คนไปเติมข้อมูล (ล้มดัง)
  const [link] = await db
    .select({ departmentId: employeeCompany.departmentId })
    .from(employeeCompany)
    .where(
      and(
        eq(employeeCompany.employeeId, ownerPrId),
        eq(employeeCompany.companyCode, companyCode),
      ),
    )
    .limit(1);
  if (!link?.departmentId) return NO_APPROVAL_TARGET;

  const departmentId = link.departmentId;
  const dept = await db.query.department.findFirst({
    columns: { managerId: true, name: true },
    where: (table, { eq }) => eq(table.id, departmentId),
  });

  // ชื่อแผนกต้องหยิบก่อนเช็คหัวหน้า — สองอย่างนี้ขาดกันคนละเรื่อง
  // แผนกที่ยังไม่ตั้งหัวหน้าก็ยังมีชื่อ และหน้าจอต้องโชว์ชื่อได้ตามปกติ
  // (เดิม return ทางไม่มีหัวหน้าออกไปก่อนบรรทัดนี้ ชื่อแผนกจึงเป็น null ทั้งที่มีอยู่)
  const departmentName = dept?.name ?? null;
  if (!dept?.managerId) return { ...NO_APPROVAL_TARGET, departmentId, departmentName };

  const managerEmployeeId = dept.managerId;

  const manager = await db.query.employee.findFirst({
    columns: {
      firstName: true,
      lastName: true,
      firstNameEn: true,
      lastNameEn: true,
      empId: true,
      email: true,
    },
    where: (table, { eq }) => eq(table.id, managerEmployeeId),
  });

  const [account] = await db
    .select({ id: user.id })
    .from(user)
    .innerJoin(role, eq(role.id, user.roleId))
    .where(
      and(
        eq(user.employeeId, managerEmployeeId),
        inArray(role.name, APPROVER_ROLE_LIST),
        eq(user.isActive, true),
        isNull(user.deletedAt),
      ),
    );

  return {
    departmentId,
    departmentName,
    managerEmployeeId,
    managerUserId: account?.id ?? null,
    managerFirstName: manager?.firstName ?? null,
    managerLastName: manager?.lastName ?? null,
    managerFirstNameEn: manager?.firstNameEn ?? null,
    managerLastNameEn: manager?.lastNameEn ?? null,
    managerEmpId: manager?.empId ?? null,
    managerEmail: manager?.email ?? null,
  };
}

export async function findOneOrFail(poNumber: string) {
  const po = await db.query.purchaseOrder.findFirst({
    where: (po, { eq }) => eq(po.poNumber, poNumber),
    with: {
      items: {
        orderBy: (item, { asc }) => [asc(item.poLine )],
        with: { grpoLines: { with: { grpo: true }, orderBy: (line, { asc }) => [asc(line.grpoId)] } },
      },
    },
  });
  if (!po) throw new NotFoundError(`Purchase order ${poNumber}`);

  const target = await findApprovalTarget(po.companyCode, po.ownerPrId);

  const registered = await registeredByItem([poNumber]);
  const items = po.items.map((item) => withLineTotals(item, registered));
  return {
    ...po,
    departmentId: target.departmentId,
    departmentName: target.departmentName,
    items,
    receivedStatus: toReceivedStatus(items),
    registrationStatus: toRegistrationStatus(items),
    managerId: target.managerEmployeeId,
    managerFirstName: target.managerFirstName,
    managerLastName: target.managerLastName,
    manageremail: target.managerEmail,
  };
}

export async function findPage({ page, limit, search, companyCode, sort }: FindPageParams) {
  // ── ค้นแบบ "มีอยู่ในสตริง" ไม่ใช่ "ขึ้นต้นด้วย" (0021)
  //
  // ตั้งแต่เลข PO เก็บพร้อม prefix ('APO-62605007') การค้นแบบขึ้นต้นทำให้คนที่พิมพ์
  // เลขเปล่า '62605007' ตามความเคยชินหาไม่เจอเลย ทั้งที่ใบนั้นมีอยู่
  // ยอมแลกกับการที่ pg ใช้ index ไม่ได้ — ตาราง PO มีหลักร้อยแถว ไม่ใช่คอขวด
  // and() ตัด undefined ทิ้งให้เอง — ไม่ส่งตัวกรองมาเลยก็ได้ where เป็น undefined เหมือนเดิม
  // (ต้องเป็นแบบนี้ หน้า autocomplete เดิมยิงมาโดยไม่มี companyCode และต้องได้ผลเท่าเดิม)
  const where = and(
    search
      ? or(ilike(purchaseOrder.poNumber, `%${search}%`), ilike(purchaseOrder.vendorName, `%${search}%`))
      : undefined,
    companyCode ? eq(purchaseOrder.companyCode, companyCode) : undefined,
  );

  const [rows, totalResult] = await Promise.all([
    db.query.purchaseOrder.findMany({
      where,
      // ★ poNumber เป็น tiebreak เสมอ ไม่ใช่ของแถม — poDate ซ้ำกันได้เยอะ (วันเดียวหลายใบ)
      //   ถ้าไม่มีตัวตัดสิน pg ไม่การันตีลำดับ แล้วแถวจะสลับที่ระหว่างหน้า ทำให้เลื่อนหน้า
      //   แล้วเห็นใบเดิมซ้ำหรือข้ามใบไปเลย (คลาสเดียวกับ orderBy ของ findDepartments)
      orderBy: (po, { desc, asc }) =>
        sort === 'date_asc' ? [asc(po.poDate), asc(po.poNumber)] : [desc(po.poDate), asc(po.poNumber)],
      limit,
      offset: (page - 1) * limit,
    }),
    db.select({ value: count() }).from(purchaseOrder).where(where),
  ]);

  // เติมสถานะทั้งสองโดยไม่พ่วง items/grpoLines กลับไป — หน้า list ยังเบาเหมือนเดิม
  const totals = await totalsByPo(rows.map((r) => r.poNumber));
  const data = rows.map((po) => {
    const lines = totals.get(po.poNumber) ?? [];
    return {
      ...po,
      receivedStatus: toReceivedStatus(lines),
      registrationStatus: toRegistrationStatus(lines),
    };
  });

  return paginate(data, requireScalar(totalResult, 'count purchase_order'), page, limit);
}
