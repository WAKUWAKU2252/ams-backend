// ═══════════════════════════════════════════════════════════════════════════
// Dashboard — ภาพรวมทะเบียนสินทรัพย์ + มูลค่าทางบัญชี
//
// สามข้อที่ต้องไม่พังตอนแก้ไฟล์นี้:
//
// 1. **ขอบเขตมาจาก token ไม่ใช่จาก query** — พนักงานทั่วไปเห็นได้แค่แผนกตัวเอง และ
//    "แผนกตัวเอง" ถูกอ่านจาก user -> employee -> department ฝั่ง server ทั้งหมด
//    departmentId ที่ส่งมาถูกทิ้งไปเลยสำหรับ role กลุ่มนี้ ไม่ใช่แค่ซ่อน dropdown
//    (มูลค่าทรัพย์สินรายแผนกคือข้อมูลที่บริษัทไม่เปิดให้ทุกคนดู)
//
// 2. **ยอดเงินสามก้อนต้องนับจากชุดเดียวกัน** — ราคาทุน / ค่าเสื่อมสะสม / มูลค่าคงเหลือ
//    ทั้งหมดกรองด้วย VALUED เหมือนกันเป๊ะ ถ้าใครแก้ให้แต่ละก้อนนับจาก "ชิ้นที่มีช่องนั้น"
//    ตัวเลขบนจอจะบวกลบไม่ลงตัว แล้วบัญชีจะอ่านเป็นบั๊กทันที (และเถียงไม่ได้ด้วย)
//
// 3. **null ≠ 0** — ไม่มีชิ้นไหนมีตัวเลขบัญชีเลย ต้องได้ null ไม่ใช่ 0
//    0 อ่านว่า "ทรัพย์สินไม่มีมูลค่า" ซึ่งคนละเรื่องกับ "ยังไม่มีตัวเลขให้รวม" คนละทางแก้
// ═══════════════════════════════════════════════════════════════════════════
import { and, asc, count, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { asset, assetAccounting, company, department, employee, user } from '@intrastucture/db/schema';
import { NotFoundError } from '@common/errors';
import { requireRow } from '@common/db-result';
import { DASHBOARD_ALL_DEPARTMENT_ROLE_LIST } from '@common/roles';
import type {
  AssetStatus,
  CompanySummary,
  DashboardRemainingLife,
  DashboardOverview,
  DashboardOverviewInput,
  DashboardScope,
  DepartmentSummary,
  StatusCount,
} from './dashboard.types';

/** ลำดับที่อยากให้สถานะเรียงบนหน้าจอ — ตรงกับลำดับใน enumAssetStatus */
const STATUS_ORDER: AssetStatus[] = ['Active', 'Inactive', 'Under Maintenance', 'Lost', 'Disposed'];

/**
 * ชิ้นที่นับเป็น "สินทรัพย์ถาวร" ของหน้านี้ = อยู่ในทะเบียนแล้วเท่านั้น
 *
 * DRAFT ไม่นับ — ยังไม่มีเลขสินทรัพย์ = บัญชียังไม่รับเข้าทะเบียน SAP การเอามารวมจะทำให้
 * ยอดของ AMS ไม่ตรงกับรายงานของบัญชีตลอดเวลาโดยไม่มีใครอธิบายได้ว่าส่วนต่างมาจากไหน
 * CANCELLED ก็ไม่นับ — บัญชีปิดถาวรแล้วว่าของชิ้นนั้นจะไม่เป็นสินทรัพย์
 *
 * ★ ต้องเป็นเงื่อนไขก้อนเดียวที่ใช้ร่วมทุกคิวรีในไฟล์นี้ ทั้งใน WHERE (คิวรีที่ตั้งต้นจาก
 *   asset) และใน ON ของ LEFT JOIN (คิวรีรายแผนกที่ตั้งต้นจาก department) — ถ้าสองที่นี้
 *   นิยาม "ชิ้นที่นับ" ต่างกันเมื่อไหร่ ยอดรวมรายแผนกจะไม่เท่ากับ totals แล้วไม่มีใครรู้
 */
const REGISTERED_ASSET = and(isNull(asset.deletedAt), eq(asset.lifecycle, 'REGISTERED'));

/**
 * เงื่อนไขของ asset ที่ทุกคิวรีในไฟล์นี้ต้องใช้ร่วมกัน
 *
 * ★ ทั้งสองแกนต้องถูกส่งต่อไปทุกที่ที่นับของ ไม่ใช่แค่คิวรี totals — ถ้าลืมที่ไหนที่หนึ่ง
 *   ตัวเลขบนหน้าจะกระทบยอดกันไม่ได้ แล้วอ่านเป็นบั๊กทันที (และเถียงไม่ได้ด้วย)
 */
function assetFilter(departmentId: number | null, companyCode: string | null): SQL | undefined {
  return and(
    REGISTERED_ASSET,
    departmentId === null ? undefined : eq(asset.departmentId, departmentId),
    companyCode === null ? undefined : eq(asset.companyCode, companyCode),
  );
}

/**
 * ชิ้นที่เอาไปรวมเป็นเงินได้ — ต้องมีทั้งราคาทุนและค่าเสื่อมสะสม
 *
 * ขาดตัวใดตัวหนึ่งแปลว่ามูลค่าคงเหลือของชิ้นนั้นคำนวณไม่ได้ ถ้าปล่อยให้ไปรวมเฉพาะช่องที่มี
 * ยอดสามก้อนจะนับจากคนละชุดกัน (ดูหัวไฟล์ข้อ 2)
 */
const VALUED = sql`${assetAccounting.bookedCost} is not null and ${assetAccounting.accumulatedDepreciation} is not null`;

const SUM_COST = sql<
  number | null
>`(sum(${assetAccounting.bookedCost}) filter (where ${VALUED}))::float8`;

const SUM_DEP = sql<
  number | null
>`(sum(${assetAccounting.accumulatedDepreciation}) filter (where ${VALUED}))::float8`;

// คำนวณเป็น numeric ก่อนแล้วค่อยแปลงเป็น float8 ครั้งเดียว — ลบกันฝั่ง JS จากเลขที่ผ่าน
// float มาแล้วสองตัวมีโอกาสเหลือเศษ .00000001 โผล่บนจอ
const SUM_NBV = sql<number | null>`(
  sum(${assetAccounting.bookedCost}) filter (where ${VALUED})
  - sum(${assetAccounting.accumulatedDepreciation}) filter (where ${VALUED})
)::float8`;

/**
 * ★ นับ asset.id ไม่ใช่ count(*) — คิวรีรายแผนกตั้งต้นจาก department แล้ว LEFT JOIN asset
 *   แผนกที่ไม่มีสินทรัพย์เลยจะได้ 1 แถวที่ทุกช่องของ asset เป็น NULL ซึ่ง count(*) จะนับ
 *   เป็น 1 แล้วรายงานว่าแผนกนั้นมีสินทรัพย์ 1 ชิ้น (ผิด และผิดแบบเนียนมาก)
 */
const COUNT_ASSETS = sql<number>`count(${asset.id})::int`;

const COUNT_ACTIVE = sql<number>`count(${asset.id}) filter (where ${asset.status} = 'Active')::int`;

/**
 * แปลง companyCode ที่ส่งมาเป็นบริษัทจริง — แยกจาก resolveScope โดยตั้งใจ
 *
 * ★ บริษัทไม่ใช่แกนของสิทธิ์ ต่างจากแผนก จึงไม่ผ่าน role เลย ใครเลือกบริษัทไหนก็ได้
 *   (ดูเหตุผลเต็มที่ DashboardScope.companyCode)
 *
 * รหัสที่ไม่มีในตารางต้องเป็น 404 ไม่ใช่เงียบ ๆ แล้วคืนศูนย์ — คืนศูนย์จะอ่านเหมือน
 * "บริษัทนี้ไม่มีสินทรัพย์" ซึ่งคนละเรื่องกับ "พิมพ์รหัสผิด" คนละทางแก้
 */
async function resolveCompany(
  requested: string | undefined,
): Promise<{ code: string; name: string } | null> {
  if (requested === undefined) return null;
  // ไม่กรอง isActive — บริษัทที่เลิกใช้แล้วยังมีสินทรัพย์ค้างอยู่ได้ และบัญชียังต้องดูได้
  // (กติกาเดียวกับแผนกที่ยุบไปแล้วใน resolveScope)
  const row = await db.query.company.findFirst({ where: eq(company.code, requested) });
  if (!row) throw new NotFoundError(`บริษัทรหัส ${requested}`);
  return { code: row.code, name: row.name };
}

/**
 * ใครเห็นอะไรได้บ้าง — จุดเดียวที่ตัดสินเรื่องนี้ ห้ามให้ที่อื่นตีความซ้ำ
 *
 * ★ role ที่ไม่อยู่ใน DASHBOARD_ALL_DEPARTMENT_ROLES จะถูก **บังคับ** เป็นแผนกตัวเอง
 *   ไม่ใช่โยน 403 เมื่อส่ง departmentId ของแผนกอื่นมา — 403 จะทำให้หน้าจอพังทั้งหน้า
 *   ทั้งที่สิ่งที่ผู้ใช้ควรได้คือ "ข้อมูลของแผนกตัวเอง" ซึ่งเขามีสิทธิ์ดูอยู่แล้ว
 *   และผลลัพธ์บอกกลับไปเสมอว่าตัวเลขที่ได้เป็นของแผนกไหน (scope.departmentName)
 */
type DepartmentScope = Omit<DashboardScope, 'companyCode' | 'companyName'>;

async function resolveScope(
  currentUser: { id: number; role: string },
  requested: number | undefined,
): Promise<DepartmentScope> {
  if (DASHBOARD_ALL_DEPARTMENT_ROLE_LIST.includes(currentUser.role)) {
    if (requested === undefined) {
      return { kind: 'ALL', departmentId: null, departmentName: null, locked: false };
    }
    // ไม่กรอง isActive — แผนกที่ยุบไปแล้วยังมีสินทรัพย์ค้างอยู่จริง และบัญชียังต้องดูได้
    const dep = await db.query.department.findFirst({ where: eq(department.id, requested) });
    if (!dep) throw new NotFoundError(`แผนก id ${requested}`);
    return { kind: 'ALL', departmentId: dep.id, departmentName: dep.name, locked: false };
  }

  const rows = await db
    .select({ departmentId: department.id, departmentName: department.name })
    .from(user)
    .innerJoin(employee, eq(employee.id, user.employeeId))
    .innerJoin(department, eq(department.id, employee.departmentId))
    .where(eq(user.id, currentUser.id));

  const own = rows[0];
  // ไม่มีแถว = user ยังไม่ผูก employee (employee ที่ชี้ไปแผนกที่ไม่มีจริงถูก FK กันไว้แล้ว)
  if (!own) return { kind: 'UNLINKED', departmentId: null, departmentName: null, locked: true };

  return {
    kind: 'OWN_DEPARTMENT',
    departmentId: own.departmentId,
    departmentName: own.departmentName,
    locked: true,
  };
}

/** ผลลัพธ์ของคนที่ระบบยังบอกไม่ได้ว่าอยู่แผนกไหน — ศูนย์ทุกช่อง แต่ยอดเงินเป็น null */
function emptyOverview(scope: DashboardScope, fiscalYear: number): DashboardOverview {
  return {
    scope,
    totals: {
      assets: 0,
      valued: 0,
      unvalued: 0,
      bookedCost: null,
      accumulatedDepreciation: null,
      netBookValue: null,
    },
    freshness: { fiscalYear, currentYearCount: 0, staleCount: 0, noDataCount: 0 },
    status: { active: 0, inactive: 0, activePercent: null, inactivePercent: null, breakdown: [] },
    byDepartment: [],
    remainingLife: null,
    // ไม่มีแผนกให้นับก็ไม่มีอะไรให้แยกรายบริษัท — ช่องเลือกบริษัทบนจอจะเหลือแค่ "ทั้งหมด"
    // ซึ่งถูกแล้ว เพราะคนกลุ่มนี้ต้องไปให้ผู้ดูแลผูกบัญชีกับพนักงานก่อน ไม่ใช่ไปกรองดูของ
    byCompany: [],
  };
}

export async function overview(
  currentUser: { id: number; role: string },
  input: DashboardOverviewInput = {},
): Promise<DashboardOverview> {
  // เกณฑ์ "ปีปัจจุบัน" ใช้ปีปฏิทินเหมือนหน้า My asset — ต้องเป็นตัวเดียวกันทั้งระบบ
  // ไม่งั้นชิ้นเดียวกันจะขึ้นป้าย "ข้อมูลปีนี้" ที่หน้าหนึ่งและ "ปีเก่า" ที่อีกหน้า
  const fiscalYear = new Date().getFullYear();

  // ตรวจรหัสบริษัทก่อนทุกอย่าง — รหัสผิดต้อง 404 ไม่ใช่ไปโผล่เป็นตัวเลขศูนย์ทั้งหน้า
  const companyRow = await resolveCompany(input.companyCode);
  const departmentScope = await resolveScope(currentUser, input.departmentId);
  const scope: DashboardScope = {
    ...departmentScope,
    companyCode: companyRow?.code ?? null,
    companyName: companyRow?.name ?? null,
  };
  if (scope.kind === 'UNLINKED') return emptyOverview(scope, fiscalYear);

  const where = assetFilter(scope.departmentId, scope.companyCode);

  const totalsRows = await db
    .select({
      assets: count(),
      valued: sql<number>`count(*) filter (where ${VALUED})::int`,
      // "มีแถวบัญชี" ต่างจาก "รวมเป็นเงินได้" — แถวที่มีอยู่แต่ราคาทุนว่างก็ยังนับว่ามีแถว
      withAccounting: sql<number>`count(${assetAccounting.assetId})::int`,
      currentYearCount: sql<number>`count(*) filter (where ${assetAccounting.fiscalYear} = ${fiscalYear})::int`,
      bookedCost: SUM_COST,
      accumulatedDepreciation: SUM_DEP,
      netBookValue: SUM_NBV,
    })
    .from(asset)
    .leftJoin(assetAccounting, eq(assetAccounting.assetId, asset.id))
    .where(where);

  const totals = requireRow(totalsRows, 'dashboard totals');

  const statusRows = await db
    .select({ status: asset.status, count: count() })
    .from(asset)
    .where(where)
    .groupBy(asset.status);

  const byStatus = new Map<AssetStatus, number>(statusRows.map((r) => [r.status, r.count]));
  const breakdown: StatusCount[] = STATUS_ORDER.filter((s) => (byStatus.get(s) ?? 0) > 0).map(
    (s) => ({ status: s, count: byStatus.get(s) ?? 0 }),
  );

  const active = byStatus.get('Active') ?? 0;
  const inactive = totals.assets - active;

  // ยิงคู่กันไปเลย ไม่ได้ใช้ผลของกันและกัน
  const [byDepartment, byCompany, remainingLife] = await Promise.all([
    summarizeByDepartment(scope.departmentId, scope.companyCode),
    // ★ ไม่ส่ง scope.companyCode เข้าไปโดยตั้งใจ — ลิสต์นี้เป็นตัวเลือกใน dropdown ด้วย
    //   กรองตามที่เลือกเมื่อไหร่ ผู้ใช้จะกดกลับไปบริษัทอื่นไม่ได้อีก (ดู CompanySummary)
    summarizeByCompany(scope.departmentId),
    summarizeRemainingLife(scope.departmentId, scope.companyCode),
  ]);

  return {
    scope,
    totals: {
      assets: totals.assets,
      valued: totals.valued,
      unvalued: totals.assets - totals.valued,
      bookedCost: totals.bookedCost,
      accumulatedDepreciation: totals.accumulatedDepreciation,
      netBookValue: totals.netBookValue,
    },
    freshness: {
      fiscalYear,
      currentYearCount: totals.currentYearCount,
      staleCount: totals.withAccounting - totals.currentYearCount,
      noDataCount: totals.assets - totals.withAccounting,
    },
    status: {
      active,
      inactive,
      // ไม่มีชิ้นเลย = คิดเปอร์เซ็นต์ไม่ได้ ต้องเป็น null ไม่ใช่ 0 (ดูหัวไฟล์ข้อ 3)
      activePercent: totals.assets === 0 ? null : (active / totals.assets) * 100,
      inactivePercent: totals.assets === 0 ? null : (inactive / totals.assets) * 100,
      breakdown,
    },
    byDepartment,
    byCompany,
    remainingLife,
  };
}

/**
 * สรุปรายแผนก — **ตั้งต้นจากตาราง department ไม่ใช่ asset**
 *
 * ★ ทิศทางของ JOIN คือหัวใจของฟังก์ชันนี้ ห้ามกลับด้าน
 *   เดิมตั้งต้นจาก asset แล้ว GROUP BY — แผนกที่ไม่มีสินทรัพย์เลยจะไม่เกิด group จึงไม่มี
 *   แถวออกมา (วัดจริง 2026-08-20: มี 62 แผนก แต่มีแค่ 31 แผนกที่มีของ = หายไปครึ่งหนึ่ง)
 *   ผลคือคนหาแผนกตัวเองไม่เจอ แล้วแยกไม่ออกว่า "ไม่มีของสักชิ้น" หรือ "ระบบมีบั๊ก"
 *   ซึ่งคนละเรื่องคนละทางแก้ — และแผนกพวกนั้นก็ไม่โผล่ใน dropdown ให้กรองด้วย
 *
 * ★ เงื่อนไขของ asset ต้องอยู่ใน ON ของ LEFT JOIN เท่านั้น ห้ามย้ายไป WHERE
 *   ย้ายเมื่อไหร่ LEFT JOIN จะกลายเป็น INNER JOIN โดยปริยาย (แถวที่ asset เป็น NULL
 *   ตกเงื่อนไขทุกข้อ) แล้วแผนก 0 ชิ้นจะหายไปอีกครั้งแบบเงียบ ๆ
 */
async function summarizeByDepartment(
  departmentId: number | null,
  companyCode: string | null,
): Promise<DepartmentSummary[]> {
  const rows = await db
    .select({
      departmentId: department.id,
      departmentName: department.name,
      assets: COUNT_ASSETS,
      active: COUNT_ACTIVE,
      bookedCost: SUM_COST,
      accumulatedDepreciation: SUM_DEP,
      netBookValue: SUM_NBV,
    })
    .from(department)
    // เงื่อนไขบริษัทอยู่ใน ON ไม่ใช่ WHERE ด้วยเหตุผลเดียวกับ REGISTERED_ASSET ข้างบน
    .leftJoin(
      asset,
      and(
        eq(asset.departmentId, department.id),
        REGISTERED_ASSET,
        companyCode === null ? undefined : eq(asset.companyCode, companyCode),
      ),
    )
    .leftJoin(assetAccounting, eq(assetAccounting.assetId, asset.id))
    .where(
      departmentId === null
        ? // แผนกที่ปิดใช้งานแล้ว "แต่ยังมีของค้างอยู่" ต้องโผล่ด้วย ไม่งั้นของก้อนนั้นหายจาก
          // ตารางทั้งที่ยังถูกนับใน totals แล้วยอดรวมรายแผนกจะไม่เท่ากับ Total fixed asset
          // — ส่วนต่างที่อธิบายไม่ได้บนหน้า dashboard คือสิ่งที่ทำให้คนเลิกเชื่อทั้งหน้า
          or(eq(department.isActive, true), isNotNull(asset.id))
        : // กรองแผนกเดียว: เอาแผนกนั้นเสมอแม้ปิดใช้งานหรือไม่มีของ — ผลลัพธ์ต้องเป็น
          // "แถวที่บอกว่า 0 ชิ้น" ไม่ใช่ตารางว่างที่อ่านเหมือนโหลดไม่สำเร็จ
          eq(department.id, departmentId),
    )
    .groupBy(department.id, department.name)
    // มากไปน้อยตามจำนวนชิ้น แล้วค่อยเรียงชื่อ — แผนก 0 ชิ้นจึงไปกองท้ายตารางเอง
    .orderBy(sql`count(${asset.id}) desc`, asc(department.name));

  const summaries: DepartmentSummary[] = rows.map((r) => ({ ...r }));

  // ── ชิ้นที่ยังไม่ระบุแผนก (asset.departmentId เป็น NULL)
  //
  // LEFT JOIN ที่ตั้งต้นจาก department จับของกลุ่มนี้ไม่ได้เลย (ไม่มีแผนกให้ join ไปหา)
  // ถ้าไม่ต่อท้ายให้ ยอดรวมรายแผนกจะขาดไปเท่ากับจำนวนชิ้นกลุ่มนี้
  //
  // ตอนนี้ ams_db มี 0 ชิ้น (วัด 2026-08-20) แต่คอลัมน์ยัง nullable อยู่จริง — วันที่มีของ
  // หลุดเข้ามาสักชิ้น ตัวเลขต้องไม่เพี้ยนโดยไม่มีใครรู้ ไม่กรองแผนกอยู่เท่านั้นถึงจะนับ
  // (กรองแผนกเดียว = ถามถึงแผนกนั้น ของที่ไม่มีแผนกไม่ใช่คำตอบ)
  if (departmentId === null) {
    const orphanRows = await db
      .select({
        assets: count(),
        active: COUNT_ACTIVE,
        bookedCost: SUM_COST,
        accumulatedDepreciation: SUM_DEP,
        netBookValue: SUM_NBV,
      })
      .from(asset)
      .leftJoin(assetAccounting, eq(assetAccounting.assetId, asset.id))
      .where(and(assetFilter(null, companyCode), isNull(asset.departmentId)));

    const orphan = requireRow(orphanRows, 'dashboard orphan department');
    // ไม่มีของกลุ่มนี้ = ไม่ต้องมีแถว (แถว 0 ที่ไม่ใช่แผนกจริงมีแต่ทำให้สับสน)
    if (orphan.assets > 0) {
      summaries.push({ departmentId: null, departmentName: null, ...orphan });
    }
  }

  return summaries;
}

/**
 * สรุปรายบริษัท — **ตั้งต้นจากตาราง company ไม่ใช่ asset** ด้วยเหตุผลเดียวกับรายแผนก
 * บริษัทที่ยังไม่มีของสักชิ้นต้องมีแถวออกมาเป็น 0 ไม่ใช่หายไปเฉย ๆ
 * ไม่งั้นมันจะไม่โผล่ใน dropdown แล้วผู้ใช้จะเลือกดูไม่ได้เลยว่ามีอะไรอยู่บ้าง
 *
 * ★ ไม่รับ companyCode — ก้อนนี้เป็นตัวเลือกใน dropdown ด้วย (ดู CompanySummary)
 *
 * ★ เงื่อนไขแผนกต้องอยู่ใน ON ของ LEFT JOIN เท่านั้น ห้ามย้ายไป WHERE
 *   ย้ายเมื่อไหร่ LEFT JOIN กลายเป็น INNER JOIN โดยปริยาย แล้วบริษัท 0 ชิ้นหายเงียบ ๆ
 *
 * ไม่มีแถว "ยังไม่ระบุบริษัท" คู่กับของแผนก — asset.companyCode เป็น NOT NULL
 * และมี FK ไป company.code จึงไม่มีทางมีชิ้นที่ไม่มีบริษัท (ต่างจาก departmentId ที่ nullable)
 */
async function summarizeByCompany(departmentId: number | null): Promise<CompanySummary[]> {
  const rows = await db
    .select({
      companyCode: company.code,
      companyName: company.name,
      assets: COUNT_ASSETS,
      active: COUNT_ACTIVE,
      bookedCost: SUM_COST,
      accumulatedDepreciation: SUM_DEP,
      netBookValue: SUM_NBV,
    })
    .from(company)
    .leftJoin(
      asset,
      and(
        eq(asset.companyCode, company.code),
        REGISTERED_ASSET,
        departmentId === null ? undefined : eq(asset.departmentId, departmentId),
      ),
    )
    .leftJoin(assetAccounting, eq(assetAccounting.assetId, asset.id))
    .where(
      // ในเครือมี 7 บริษัท แต่ 5 บริษัทไม่มี SAP ให้ sync จึงไม่มีทางมีสินทรัพย์เข้ามา
      // ถ้าโชว์หมดจะได้ dropdown ที่มีตัวเลือกตายอยู่ 5 อัน — เอาเฉพาะที่ "มีทางจะมีของ"
      // (เปิดใช้งาน + ต่อ SAP) หรือ "มีของค้างอยู่จริง" แม้จะปิดใช้งานไปแล้ว
      or(and(eq(company.isActive, true), isNotNull(company.sapDbName)), isNotNull(asset.id)),
    )
    .groupBy(company.code, company.name)
    // มากไปน้อยตามจำนวนชิ้น แล้วค่อยเรียงรหัส — บริษัท 0 ชิ้นไปกองท้ายเอง
    .orderBy(sql`count(${asset.id}) desc`, asc(company.code));

  return rows.map((r) => ({ ...r }));
}

/**
 * การกระจายของอายุคงเหลือในแผนกเดียว
 *
 * ★ คืน null เมื่อยังไม่ได้เลือกแผนก — ไม่ใช่แค่ซ่อนบนจอ แต่ไม่คิดให้เลย
 *   รวมทั้งบริษัทแล้วกราฟจะกลายเป็นรูปเดียวกันทุกครั้งจนไม่มีใครอ่าน (ดู DashboardRemainingLife)
 *
 * ★ นับด้วย filter ในคิวรีเดียว ไม่ใช่ GROUP BY ช่วง — ได้ครบทุกช่องเสมอแม้ช่องนั้นเป็น 0
 *   ถ้า GROUP BY ช่วงที่ไม่มีของจะหายไปจากผล แล้วกราฟจะขาดแท่งเป็นช่วง ๆ โดยไม่มีอะไรฟ้อง
 *
 * ★ เงื่อนไขของช่วงเวลาต้องตัด usefulLifeMonths = 0 ออกทุกช่อง — ของที่ไม่คิดค่าเสื่อม
 *   (ที่ดิน) มี remainingLifeMonths = 0 เหมือนของที่ตัดครบแล้วเป๊ะ ถ้าไม่แยกจะถูกนับ
 *   เป็น "ตัดครบแล้ว" ทั้งที่ไม่เคยเริ่มตัดเลย
 */
async function summarizeRemainingLife(
  departmentId: number | null,
  companyCode: string | null,
): Promise<DashboardRemainingLife | null> {
  if (departmentId === null) return null;

  const where = assetFilter(departmentId, companyCode);
  const life = assetAccounting.remainingLifeMonths;
  const useful = assetAccounting.usefulLifeMonths;

  // ช่วงเวลาทั้งหมดต้อง "คิดค่าเสื่อมอยู่จริง" (useful <> 0) และมีตัวเลขอายุคงเหลือ
  const inRange = (lo: number, hi: number | null) =>
    hi === null
      ? sql<number>`count(*) filter (where ${useful} <> 0 and ${life} > ${lo})::int`
      : sql<number>`count(*) filter (where ${useful} <> 0 and ${life} >= ${lo} and ${life} <= ${hi})::int`;

  const rows = await db
    .select({
      expired: sql<number>`count(*) filter (where ${useful} <> 0 and ${life} = 0)::int`,
      m1: inRange(1, 12),
      m2: inRange(13, 24),
      m3: inRange(25, 36),
      m4: inRange(37, 48),
      m5: inRange(49, 60),
      over: inRange(60, null),
      noDepreciation: sql<number>`count(*) filter (where ${useful} = 0)::int`,
      // ไม่มีแถวบัญชีเลย หรือมีแถวแต่ SAP ไม่ได้ให้อายุมา — ตอบไม่ได้ทั้งคู่
      noData: sql<number>`count(*) filter (where ${assetAccounting.assetId} is null or ${life} is null or ${useful} is null)::int`,
    })
    .from(asset)
    .leftJoin(assetAccounting, eq(assetAccounting.assetId, asset.id))
    .where(where);

  const r = requireRow(rows, 'dashboard remaining life');

  return {
    buckets: [
      { label: 'ตัดครบแล้ว', count: r.expired },
      { label: '1–12 เดือน', count: r.m1 },
      { label: '13–24 เดือน', count: r.m2 },
      { label: '25–36 เดือน', count: r.m3 },
      { label: '37–48 เดือน', count: r.m4 },
      { label: '49–60 เดือน', count: r.m5 },
      { label: 'เกิน 60 เดือน', count: r.over },
    ],
    noDepreciation: r.noDepreciation,
    noData: r.noData,
  };
}
