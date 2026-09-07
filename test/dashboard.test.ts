// ═══ GET /dashboard/overview — ภาพรวมทะเบียน + มูลค่าทางบัญชี ═══
//
// สามเรื่องที่เทสต์นี้เฝ้า:
//
// 1. **ขอบเขตตาม role** — พนักงานทั่วไปเห็นได้แค่แผนกตัวเอง และต้องเห็นแค่นั้นจริง ๆ
//    แม้จะส่ง departmentId ของแผนกอื่นมาเองก็ตาม (นี่คือการรั่วของ "มูลค่าทรัพย์สิน
//    รายแผนก" ไม่ใช่แค่ตัวเลขผิด)
//
// 2. **ยอดเงินสามก้อนต้องลงตัว** — ราคาทุน − ค่าเสื่อมสะสม = มูลค่าคงเหลือ เสมอ
//    ชิ้นที่มีตัวเลขไม่ครบต้องถูกกันออกจากทั้งสามก้อนพร้อมกัน ไม่ใช่กันเฉพาะก้อนที่ขาด
//
// 3. **null ≠ 0** — ไม่มีชิ้นไหนมีตัวเลขบัญชีเลยต้องได้ null ส่วนที่ดินที่ค่าเสื่อมเป็น 0 จริง
//    ต้องได้ 0 ถ้าโค้ดไหนเผลอใช้ `|| null` หรือ coalesce(...,0) สองเคสนี้จะกลืนกัน
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { asset, assetAccounting, department, employee } from '@intrastucture/db/schema';
import * as dashboardService from '@modules/business/dashboard/dashboard.service';
import { makeDepartment, makeEmployee, makeLocation, makeUser, resetDb, TEST_COMPANY } from './helpers/factory';

type Lifecycle = 'DRAFT' | 'REGISTERED' | 'CANCELLED';
type Status = 'Active' | 'Inactive' | 'Under Maintenance' | 'Lost' | 'Disposed';

let locationId = 0;

/**
 * ของเก่าจาก SAP — ใช้เพราะไม่ต้องมีโซ่ PO ครบชุดเหมือน PO_FLOW
 *
 * assetNumber บังคับทั้งจาก ck_asset_origin_chain (ฝั่ง SAP_LEGACY) และ
 * ck_asset_registered_needs_number — ออกเลขไม่ซ้ำให้เองทุกครั้ง (uq_asset_number)
 */
async function makeAsset(opts: {
  departmentId?: number | null;
  /** ไม่ระบุ = TEST_COMPANY (UBA) — migration 0021 seed ทั้ง UBA และ UBP ไว้แล้ว */
  companyCode?: string;
  lifecycle?: Lifecycle;
  status?: Status;
  deleted?: boolean;
}): Promise<number> {
  const [row] = await db
    .insert(asset)
    .values({
      origin: 'SAP_LEGACY',
      companyCode: opts.companyCode ?? TEST_COMPANY,
      assetNumber: `TST-${crypto.randomUUID().slice(0, 8)}`,
      description: 'ของทดสอบ',
      locationId,
      departmentId: opts.departmentId ?? null,
      lifecycle: opts.lifecycle ?? 'REGISTERED',
      status: opts.status ?? 'Active',
      deletedAt: opts.deleted ? new Date().toISOString() : null,
    })
    .returning();
  return row!.id;
}

async function makeAccounting(
  assetId: number,
  over: {
    fiscalYear?: number;
    bookedCost?: number | null;
    accumulatedDepreciation?: number | null;
    /** 0 = ไม่คิดค่าเสื่อมเลย (ที่ดิน) — คนละเรื่องกับ remainingLifeMonths = 0 */
    usefulLifeMonths?: number | null;
    /** 0 = ตัดค่าเสื่อมครบแล้ว */
    remainingLifeMonths?: number | null;
  } = {},
) {
  await db.insert(assetAccounting).values({
    assetId,
    fiscalYear: over.fiscalYear ?? new Date().getFullYear(),
    bookedCost: over.bookedCost === undefined ? 1000 : over.bookedCost,
    accumulatedDepreciation:
      over.accumulatedDepreciation === undefined ? 400 : over.accumulatedDepreciation,
    salvageValue: 1,
    usefulLifeMonths: over.usefulLifeMonths === undefined ? 60 : over.usefulLifeMonths,
    remainingLifeMonths: over.remainingLifeMonths === undefined ? 12 : over.remainingLifeMonths,
    depreciationMethod: '01 Straight',
  });
}

const asRole = (id: number, role: string) => ({ id, role });

beforeEach(async () => {
  await resetDb();
  locationId = await makeLocation();
});

describe('ขอบเขตตาม role', () => {
  test('EMPLOYEE เห็นเฉพาะแผนกตัวเอง', async () => {
    const mine = await makeDepartment('แผนกของฉัน');
    const other = await makeDepartment('แผนกอื่น');
    const emp = await makeEmployee({ departmentId: mine });
    const userId = await makeUser({ roleName: 'EMPLOYEE', employeeId: emp });

    await makeAsset({ departmentId: mine });
    await makeAsset({ departmentId: mine });
    await makeAsset({ departmentId: other });

    const res = await dashboardService.overview(asRole(userId, 'EMPLOYEE'), {});

    expect(res.scope.kind).toBe('OWN_DEPARTMENT');
    expect(res.scope.departmentId).toBe(mine);
    expect(res.scope.departmentName).toBe('แผนกของฉัน');
    expect(res.scope.locked).toBe(true);
    expect(res.totals.assets).toBe(2);
  });

  // ★ ใจกลางของเทสต์ไฟล์นี้ — ถ้าข้อนี้ล้ม แปลว่าใครก็ดูมูลค่าทรัพย์สินของแผนกอื่นได้
  test('EMPLOYEE ส่ง departmentId ของแผนกอื่นมา → ถูกทิ้ง บังคับเป็นแผนกตัวเอง', async () => {
    const mine = await makeDepartment('แผนกของฉัน');
    const other = await makeDepartment('แผนกอื่น');
    const emp = await makeEmployee({ departmentId: mine });
    const userId = await makeUser({ roleName: 'EMPLOYEE', employeeId: emp });

    await makeAsset({ departmentId: mine });
    await makeAsset({ departmentId: other });
    await makeAsset({ departmentId: other });
    await makeAsset({ departmentId: other });

    const res = await dashboardService.overview(asRole(userId, 'EMPLOYEE'), {
      departmentId: other,
    });

    expect(res.scope.departmentId).toBe(mine);
    expect(res.totals.assets).toBe(1);
    expect(res.byDepartment).toHaveLength(1);
    expect(res.byDepartment[0]!.departmentId).toBe(mine);
  });

  test.each(['MANAGER', 'FINANCE', 'ADMIN'])('%s เห็นทุกแผนก', async (role) => {
    const a = await makeDepartment('แผนก A');
    const b = await makeDepartment('แผนก B');
    const emp = await makeEmployee({ departmentId: a });
    const userId = await makeUser({ roleName: role, employeeId: emp });

    await makeAsset({ departmentId: a });
    await makeAsset({ departmentId: b });
    await makeAsset({ departmentId: null });

    const res = await dashboardService.overview(asRole(userId, role), {});

    expect(res.scope.kind).toBe('ALL');
    expect(res.scope.departmentId).toBeNull();
    expect(res.scope.locked).toBe(false);
    expect(res.totals.assets).toBe(3);
  });

  test('FINANCE กรองแผนกเองได้', async () => {
    const a = await makeDepartment('แผนก A');
    const b = await makeDepartment('แผนก B');
    const userId = await makeUser({ roleName: 'FINANCE' });

    await makeAsset({ departmentId: a });
    await makeAsset({ departmentId: b });
    await makeAsset({ departmentId: b });

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'), { departmentId: b });

    expect(res.scope.departmentId).toBe(b);
    expect(res.scope.departmentName).toBe('แผนก B');
    expect(res.totals.assets).toBe(2);
  });

  test('FINANCE กรองแผนกที่ไม่มีจริง → 404 ไม่ใช่คืนศูนย์เงียบ ๆ', async () => {
    const userId = await makeUser({ roleName: 'FINANCE' });
    expect(
      dashboardService.overview(asRole(userId, 'FINANCE'), { departmentId: 9999 }),
    ).rejects.toThrow();
  });

  // บัญชีที่ยังไม่ผูกพนักงาน = ระบบบอกไม่ได้ว่าอยู่แผนกไหน ต้องบอกให้ไปแก้ ไม่ใช่โชว์ศูนย์เฉย ๆ
  test('EMPLOYEE ที่ยังไม่ผูกพนักงาน → UNLINKED และไม่มีตัวเลขให้เห็น', async () => {
    const dep = await makeDepartment();
    await makeAsset({ departmentId: dep });
    const userId = await makeUser({ roleName: 'EMPLOYEE' });

    const res = await dashboardService.overview(asRole(userId, 'EMPLOYEE'), {});

    expect(res.scope.kind).toBe('UNLINKED');
    expect(res.totals.assets).toBe(0);
    expect(res.totals.bookedCost).toBeNull();
    expect(res.byDepartment).toHaveLength(0);
  });
});

describe('ชิ้นที่ถูกนับ', () => {
  test('นับเฉพาะ REGISTERED ที่ยังไม่ถูกลบ', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const dep = await makeDepartment();

    await makeAsset({ departmentId: dep });
    await makeAsset({ departmentId: dep, lifecycle: 'DRAFT' });
    await makeAsset({ departmentId: dep, lifecycle: 'CANCELLED' });
    await makeAsset({ departmentId: dep, deleted: true });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});
    expect(res.totals.assets).toBe(1);
  });

  test('ชิ้นที่ยังไม่ระบุแผนก โผล่เป็นแถวของตัวเองในสรุปรายแผนก (ยอดรวมถึงจะลงตัว)', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const dep = await makeDepartment('แผนก A');

    await makeAsset({ departmentId: dep });
    await makeAsset({ departmentId: null });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    expect(res.totals.assets).toBe(2);
    const noDept = res.byDepartment.find((d) => d.departmentId === null);
    expect(noDept?.assets).toBe(1);
    expect(noDept?.departmentName).toBeNull();
    expect(res.byDepartment.reduce((sum, d) => sum + d.assets, 0)).toBe(res.totals.assets);
  });
});

// สรุปรายแผนกตั้งต้นจากตาราง department ไม่ใช่ asset — ถ้าใครกลับทิศ JOIN กลับไป
// แผนกที่ไม่มีของจะหายไปเงียบ ๆ อีกครั้ง (ของจริงหายไปครึ่งหนึ่ง: 31 จาก 62 แผนก)
describe('สรุปรายแผนก — แผนกที่ยังไม่มีสินทรัพย์', () => {
  test('แผนกที่ไม่มีของเลย ต้องโผล่ด้วย assets = 0 และยอดเงินเป็น null', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const withAssets = await makeDepartment('แผนกมีของ');
    const empty = await makeDepartment('แผนกไม่มีของ');
    await makeAsset({ departmentId: withAssets });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    const row = res.byDepartment.find((d) => d.departmentId === empty);
    expect(row).toBeDefined();
    expect(row!.assets).toBe(0);
    expect(row!.active).toBe(0);
    // null ไม่ใช่ 0 — "ไม่มีของให้รวม" ต่างจาก "รวมแล้วได้ศูนย์"
    expect(row!.bookedCost).toBeNull();
    expect(row!.netBookValue).toBeNull();
  });

  test('แผนก 0 ชิ้น ไปกองท้ายตาราง ไม่แทรกกลางแผนกที่มีของ', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const big = await makeDepartment('ก แผนกใหญ่');
    await makeDepartment('ก แผนกว่าง');
    await makeAsset({ departmentId: big });
    await makeAsset({ departmentId: big });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    expect(res.byDepartment[0]!.departmentId).toBe(big);
    expect(res.byDepartment.at(-1)!.assets).toBe(0);
  });

  // ★ แผนกที่ปิดใช้งานแล้วแต่ยังมีของค้าง ต้องไม่หาย ไม่งั้นยอดรวมรายแผนกจะไม่เท่ากับ
  //   totals แล้วส่วนต่างนั้นอธิบายไม่ได้บนหน้าจอ
  test('แผนกที่ปิดใช้งานแล้วแต่ยังมีของ ยังต้องโผล่ (ยอดถึงจะลงตัว)', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const closed = await makeDepartment('แผนกที่ยุบไปแล้ว');
    await db.update(department).set({ isActive: false }).where(eq(department.id, closed));
    await makeAsset({ departmentId: closed });
    await makeAsset({ departmentId: closed });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    expect(res.byDepartment.find((d) => d.departmentId === closed)?.assets).toBe(2);
    expect(res.byDepartment.reduce((sum, d) => sum + d.assets, 0)).toBe(res.totals.assets);
  });

  test('แผนกที่ปิดใช้งานและไม่มีของ ไม่ต้องโผล่ (ไม่มีอะไรให้ดู)', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const closed = await makeDepartment('แผนกที่ยุบและว่าง');
    await db.update(department).set({ isActive: false }).where(eq(department.id, closed));

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    expect(res.byDepartment.find((d) => d.departmentId === closed)).toBeUndefined();
  });

  // กรองแผนกที่ไม่มีของ ต้องได้ "แถวที่บอกว่า 0" ไม่ใช่ตารางว่างที่อ่านเหมือนโหลดไม่สำเร็จ
  test('กรองไปที่แผนกที่ไม่มีของ → ได้ 1 แถวที่เป็น 0 ไม่ใช่ลิสต์ว่าง', async () => {
    const userId = await makeUser({ roleName: 'FINANCE' });
    const other = await makeDepartment('แผนกอื่น');
    const empty = await makeDepartment('แผนกไม่มีของ');
    await makeAsset({ departmentId: other });

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'), { departmentId: empty });

    expect(res.totals.assets).toBe(0);
    expect(res.byDepartment).toHaveLength(1);
    expect(res.byDepartment[0]!.departmentId).toBe(empty);
    expect(res.byDepartment[0]!.assets).toBe(0);
  });

  // ชิ้นที่มีอยู่แต่ยังไม่เข้าทะเบียนต้องไม่ทำให้แผนกนั้นดูเหมือนมีของ (เงื่อนไขอยู่ใน ON
  // ของ LEFT JOIN — ถ้าใครย้ายไป WHERE แผนกนี้จะหายทั้งแถวแทนที่จะขึ้น 0)
  test('แผนกที่มีแต่ชิ้น DRAFT/ลบแล้ว ยังนับเป็น 0 และยังโผล่อยู่', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const dep = await makeDepartment('แผนกมีแต่ร่าง');
    await makeAsset({ departmentId: dep, lifecycle: 'DRAFT' });
    await makeAsset({ departmentId: dep, deleted: true });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    const row = res.byDepartment.find((d) => d.departmentId === dep);
    expect(row?.assets).toBe(0);
    expect(res.totals.assets).toBe(0);
  });

  test('ยอดรวมรายแผนกเท่ากับ totals เสมอ แม้มีทั้งแผนกว่าง/แผนกปิด/ของไม่มีแผนก', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const a = await makeDepartment('แผนก A');
    await makeDepartment('แผนก ว่าง');
    const closed = await makeDepartment('แผนก ปิดแต่มีของ');
    await db.update(department).set({ isActive: false }).where(eq(department.id, closed));

    await makeAsset({ departmentId: a });
    await makeAsset({ departmentId: a });
    await makeAsset({ departmentId: closed });
    await makeAsset({ departmentId: null });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    expect(res.totals.assets).toBe(4);
    expect(res.byDepartment.reduce((sum, d) => sum + d.assets, 0)).toBe(4);
  });
});

describe('ยอดเงิน', () => {
  test('ราคาทุน − ค่าเสื่อมสะสม = มูลค่าคงเหลือ', async () => {
    const userId = await makeUser({ roleName: 'FINANCE' });
    const dep = await makeDepartment();

    await makeAccounting(await makeAsset({ departmentId: dep }), {
      bookedCost: 12871.03,
      accumulatedDepreciation: 12870.03,
    });
    await makeAccounting(await makeAsset({ departmentId: dep }), {
      bookedCost: 5000.5,
      accumulatedDepreciation: 1000.25,
    });

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'), {});

    expect(res.totals.valued).toBe(2);
    expect(res.totals.unvalued).toBe(0);
    expect(res.totals.bookedCost).toBeCloseTo(17871.53, 2);
    expect(res.totals.accumulatedDepreciation).toBeCloseTo(13870.28, 2);
    expect(res.totals.netBookValue).toBeCloseTo(4001.25, 2);
    expect(res.totals.netBookValue!).toBeCloseTo(
      res.totals.bookedCost! - res.totals.accumulatedDepreciation!,
      2,
    );
  });

  // ★ ชิ้นที่มีตัวเลขไม่ครบต้องหลุดออกจากทั้งสามก้อนพร้อมกัน ไม่ใช่หลุดเฉพาะก้อนที่ขาด
  //   ไม่งั้นราคาทุนจะรวมของชิ้นที่ค่าเสื่อมไม่รู้ แล้วสามก้อนบวกลบกันไม่ลงตัวบนหน้าจอ
  test('ชิ้นที่ตัวเลขบัญชีไม่ครบ ถูกกันออกจากยอดเงินทั้งสามก้อน', async () => {
    const userId = await makeUser({ roleName: 'FINANCE' });
    const dep = await makeDepartment();

    await makeAccounting(await makeAsset({ departmentId: dep }), {
      bookedCost: 1000,
      accumulatedDepreciation: 400,
    });
    // มีแถวบัญชี แต่ราคาทุนว่าง
    await makeAccounting(await makeAsset({ departmentId: dep }), {
      bookedCost: null,
      accumulatedDepreciation: 999,
    });
    // ไม่มีแถวบัญชีเลย
    await makeAsset({ departmentId: dep });

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'), {});

    expect(res.totals.assets).toBe(3);
    expect(res.totals.valued).toBe(1);
    expect(res.totals.unvalued).toBe(2);
    expect(res.totals.bookedCost).toBe(1000);
    expect(res.totals.accumulatedDepreciation).toBe(400);
    expect(res.totals.netBookValue).toBe(600);
  });

  test('ไม่มีชิ้นไหนมีตัวเลขบัญชีเลย → null ไม่ใช่ 0', async () => {
    const userId = await makeUser({ roleName: 'FINANCE' });
    const dep = await makeDepartment();
    await makeAsset({ departmentId: dep });

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'), {});

    expect(res.totals.assets).toBe(1);
    expect(res.totals.bookedCost).toBeNull();
    expect(res.totals.accumulatedDepreciation).toBeNull();
    expect(res.totals.netBookValue).toBeNull();
  });

  // ที่ดินมีค่าเสื่อมสะสม 0 จริง ๆ (วัดจาก LAN-200-12-001) — 0 ต้องไม่กลายเป็น null
  test('ค่าเสื่อมสะสม 0 ยังเป็น 0 ไม่ใช่ null', async () => {
    const userId = await makeUser({ roleName: 'FINANCE' });
    const dep = await makeDepartment();
    await makeAccounting(await makeAsset({ departmentId: dep }), {
      bookedCost: 28800000,
      accumulatedDepreciation: 0,
    });

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'), {});

    expect(res.totals.valued).toBe(1);
    expect(res.totals.accumulatedDepreciation).toBe(0);
    expect(res.totals.netBookValue).toBe(28800000);
  });
});

describe('สถานะ active/inactive', () => {
  /**
   * ★ 'Under Maintenance' ในเทสต์นี้ **ไม่ใช่สถานะที่ระบบรองรับแล้ว** — อย่าเอาไปใช้เป็นตัวอย่าง
   *
   * สถานะเหลือแค่ Active/Inactive ตาม SAP (ดู shared/utils/asset-status.ts) แต่ enum ใน DB
   * ยังมีค่าเก่าค้างอยู่เพราะ postgres ลบค่าใน enum ไม่ได้ — แถวที่ถือค่านั้นจึงยังเกิดได้จาก
   * สคริปต์หรือการแก้ SQL ด้วยมือ
   *
   * เทสต์นี้จึงเฝ้าว่า **ของแปลกต้องไม่หายเงียบ ๆ**: มันต้องโผล่ใน breakdown (ต่อท้ายสุด)
   * และผลรวมของ breakdown ต้องเท่ากับ totals เสมอ ไม่งั้นตัวเลขบนจอจะกระทบยอดกันไม่ได้
   */
  test('active คือ Active ล้วน ที่เหลือรวมเป็น inactive', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const dep = await makeDepartment();

    await makeAsset({ departmentId: dep, status: 'Active' });
    await makeAsset({ departmentId: dep, status: 'Active' });
    await makeAsset({ departmentId: dep, status: 'Active' });
    await makeAsset({ departmentId: dep, status: 'Inactive' });
    await makeAsset({ departmentId: dep, status: 'Under Maintenance' });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    expect(res.status.active).toBe(3);
    expect(res.status.inactive).toBe(2);
    expect(res.status.activePercent).toBeCloseTo(60, 5);
    expect(res.status.inactivePercent).toBeCloseTo(40, 5);
    expect(res.status.breakdown).toEqual([
      { status: 'Active', count: 3 },
      { status: 'Inactive', count: 1 },
      { status: 'Under Maintenance', count: 1 },
    ]);
  });

  test('ไม่มีชิ้นเลย → เปอร์เซ็นต์เป็น null ไม่ใช่ 0', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    expect(res.status.activePercent).toBeNull();
    expect(res.status.inactivePercent).toBeNull();
    expect(res.status.breakdown).toHaveLength(0);
  });
});

// ตัวเลขบัญชีเป็นของ "ปีล่าสุดที่ SAP มีให้ชิ้นนั้น" ซึ่งค้างที่ปีเก่าได้ (25% ของทะเบียนจริง)
// ยอดรวมจึงต้องมาคู่กับจำนวนชิ้นที่เป็นข้อมูลปีปัจจุบัน ไม่งั้นคนอ่านยอดปี 2022 เป็นของวันนี้
describe('ความสดของตัวเลขบัญชี', () => {
  test('แยกชิ้นที่เป็นข้อมูลปีนี้ / ปีเก่า / ไม่มีข้อมูล', async () => {
    const userId = await makeUser({ roleName: 'FINANCE' });
    const dep = await makeDepartment();
    const thisYear = new Date().getFullYear();

    await makeAccounting(await makeAsset({ departmentId: dep }), { fiscalYear: thisYear });
    await makeAccounting(await makeAsset({ departmentId: dep }), { fiscalYear: thisYear - 4 });
    await makeAccounting(await makeAsset({ departmentId: dep }), { fiscalYear: thisYear - 4 });
    await makeAsset({ departmentId: dep });

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'), {});

    expect(res.freshness.fiscalYear).toBe(thisYear);
    expect(res.freshness.currentYearCount).toBe(1);
    expect(res.freshness.staleCount).toBe(2);
    expect(res.freshness.noDataCount).toBe(1);
  });
});

// ═══ กรองตามบริษัท ═══
//
// ★ ทำไมต้องมีเทสต์ชุดนี้: บริษัทเป็นแกนที่สองที่เพิ่งเพิ่มเข้ามา และมันต้องถูกส่งต่อไป
//   ทุกคิวรีในไฟล์ service ไม่ใช่แค่คิวรี totals — ถ้าลืมที่ใดที่หนึ่ง ตัวเลขบนหน้าจะไม่
//   กระทบยอดกัน ซึ่งเป็นอาการที่มองด้วยตาไม่เห็นจนกว่าจะมีคนบวกเลขตาม
describe('กรองตามบริษัท', () => {
  test('ไม่ส่ง companyCode → นับทุกบริษัท', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    await makeAsset({ companyCode: 'UBA' });
    await makeAsset({ companyCode: 'UBA' });
    await makeAsset({ companyCode: 'UBP' });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    expect(res.scope.companyCode).toBeNull();
    expect(res.scope.companyName).toBeNull();
    expect(res.totals.assets).toBe(3);
  });

  test('ส่ง companyCode → นับเฉพาะบริษัทนั้น และบอกกลับว่าเป็นบริษัทไหน', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    await makeAsset({ companyCode: 'UBA' });
    await makeAsset({ companyCode: 'UBA' });
    await makeAsset({ companyCode: 'UBP' });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), { companyCode: 'UBP' });

    expect(res.scope.companyCode).toBe('UBP');
    expect(res.scope.companyName).toBe('UBP');
    expect(res.totals.assets).toBe(1);
  });

  // รหัสมั่วต้อง 404 ไม่ใช่คืนศูนย์เงียบ ๆ — ศูนย์อ่านว่า "บริษัทนี้ไม่มีของ" ซึ่งคนละเรื่อง
  test('companyCode ที่ไม่มีในตาราง → 404 ไม่ใช่ตัวเลขศูนย์', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    await makeAsset({});

    expect(
      dashboardService.overview(asRole(userId, 'ADMIN'), { companyCode: 'NOPE' }),
    ).rejects.toThrow();
  });

  test('ยอดเงินถูกกรองตามบริษัทด้วย ไม่ใช่แค่จำนวนชิ้น', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const uba = await makeAsset({ companyCode: 'UBA' });
    const ubp = await makeAsset({ companyCode: 'UBP' });
    await makeAccounting(uba, { bookedCost: 1000, accumulatedDepreciation: 400 });
    await makeAccounting(ubp, { bookedCost: 7000, accumulatedDepreciation: 2000 });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), { companyCode: 'UBP' });

    expect(res.totals.bookedCost).toBe(7000);
    expect(res.totals.accumulatedDepreciation).toBe(2000);
    expect(res.totals.netBookValue).toBe(5000);
  });

  // ── ลิสต์แผนกต้องกรองตามบริษัทด้วย (0025) ────────────────────────────────
  //
  // เดิมกรองบริษัทไว้ใน ON ของ join เท่านั้น แถวแผนกจึงหลุดมาครบทุกบริษัท — ไม่มีใครเห็น
  // ปัญหาตอนมีบริษัทเดียว พอมี 3 บริษัทตารางบน dashboard พุ่งจาก 61 เป็น 151 แถว
  // โดย 120 แถวเป็น 0 ชิ้น และชื่อซ้ำกันข้ามบริษัท 55 ชื่อจนเลือกไม่ถูก
  test('เลือกบริษัทแล้ว ลิสต์แผนกเหลือเฉพาะของบริษัทนั้น', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    await makeDepartment('แผนกของ UBA');
    await makeDepartment('แผนกของ UBP', 'UBP');

    const all = await dashboardService.overview(asRole(userId, 'ADMIN'), {});
    expect(all.byDepartment.map((d) => d.departmentName).sort()).toEqual([
      'แผนกของ UBA',
      'แผนกของ UBP',
    ]);

    const ubp = await dashboardService.overview(asRole(userId, 'ADMIN'), { companyCode: 'UBP' });
    expect(ubp.byDepartment.map((d) => d.departmentName)).toEqual(['แผนกของ UBP']);
    // หน้าจอใช้ค่านี้กำกับชื่อตอนดูทั้งเครือ — ไม่มีก็แยกแผนกชื่อซ้ำไม่ออก
    expect(ubp.byDepartment[0]!.companyCode).toBe('UBP');
  });

  // ★ ใจกลางของ describe นี้ — byDepartment ต้องกระทบยอดกับ totals เสมอ ทุกชุดตัวกรอง
  //   ถ้าลืมส่งบริษัทเข้า summarizeByDepartment ข้อนี้จะจับได้ทันที
  // ★ แผนกต้องสร้างในบริษัทของชิ้นเสมอตั้งแต่ 0026 — fk_asset_department เป็นคีย์คู่แล้ว
  //   (departmentId, companyCode) การเอาชิ้นของ UBP ไปใส่แผนกของ UBA แบบเดิม DB ปฏิเสธ
  //   ซึ่งตรงกับของจริง: แผนกเป็นของบริษัท ไม่ใช่ของกลางทั้งเครือ
  test('sum(byDepartment.assets) เท่ากับ totals.assets เมื่อกรองบริษัท', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const ubaDept = await makeDepartment('แผนก ก');
    const a = await makeDepartment('แผนก ก ของ UBP', 'UBP');
    const b = await makeDepartment('แผนก ข ของ UBP', 'UBP');
    await makeAsset({ departmentId: ubaDept, companyCode: 'UBA' });
    await makeAsset({ departmentId: a, companyCode: 'UBP' });
    await makeAsset({ departmentId: b, companyCode: 'UBP' });
    await makeAsset({ departmentId: b, companyCode: 'UBP' });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), { companyCode: 'UBP' });

    const sum = res.byDepartment.reduce((acc, r) => acc + r.assets, 0);
    expect(res.totals.assets).toBe(3);
    expect(sum).toBe(res.totals.assets);
  });

  test('กรองบริษัทกับกรองแผนกตัดกันทั้งสองแกน', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const ubaDept = await makeDepartment('แผนก ก');
    const a = await makeDepartment('แผนก ก ของ UBP', 'UBP');
    const b = await makeDepartment('แผนก ข ของ UBP', 'UBP');
    await makeAsset({ departmentId: ubaDept, companyCode: 'UBA' });
    await makeAsset({ departmentId: a, companyCode: 'UBP' });
    await makeAsset({ departmentId: b, companyCode: 'UBP' });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {
      departmentId: a,
      companyCode: 'UBP',
    });

    expect(res.totals.assets).toBe(1);
  });

  // พนักงานทั่วไปถูกล็อกทั้งสองแกน — เทสต์นี้ยิงบริษัทที่ตรงกับของตัวเองพอดี จึงเห็นแค่
  // ว่าสองแกนทำงานร่วมกันได้ ส่วนเคสที่ยิงบริษัท "อื่น" มาอยู่ใน describe ข้างล่าง
  //
  // ★ พนักงานสังกัดแผนกของ UBP ในเทสต์นี้ เพราะของที่เขาต้องเห็นเป็นของ UBP —
  //   แผนกกับชิ้นต้องเป็นบริษัทเดียวกันตั้งแต่ 0026
  test('EMPLOYEE ถูกล็อกทั้งบริษัทและแผนกของตัวเอง', async () => {
    const mine = await makeDepartment('แผนกของฉัน', 'UBP');
    const other = await makeDepartment('แผนกอื่น', 'UBP');
    const emp = await makeEmployee({ departmentId: mine, companyCode: 'UBP' });
    const userId = await makeUser({ roleName: 'EMPLOYEE', employeeId: emp });

    await makeAsset({ departmentId: mine, companyCode: 'UBP' });
    await makeAsset({ departmentId: other, companyCode: 'UBP' });

    const res = await dashboardService.overview(asRole(userId, 'EMPLOYEE'), {
      departmentId: other,
      companyCode: 'UBP',
    });

    expect(res.scope.departmentId).toBe(mine);
    expect(res.scope.locked).toBe(true);
    expect(res.scope.companyCode).toBe('UBP');
    expect(res.scope.companyLocked).toBe(true);
    expect(res.totals.assets).toBe(1);
  });
});

// ═══ ล็อกบริษัทตาม role ═══
//
// ★ ทำไมต้องมีเทสต์ชุดนี้: บริษัทเพิ่งกลายเป็น "แกนของสิทธิ์" ตัวที่สอง เดิมทุก role
//   เลือกบริษัทไหนก็ได้ การพลาดตรงนี้ไม่ทำให้อะไรพัง แค่ทำให้พนักงานของบริษัทหนึ่ง
//   อ่านมูลค่าทรัพย์สินของอีกบริษัทในเครือได้ — ซึ่งไม่มีอะไรบนหน้าจอฟ้องเลย
//
// ★ makeEmployee ไม่ได้เขียน employee.companyCode ให้ (มันเขียนแค่แถว employee_company)
//   เทสต์ที่ต้องการทดสอบ "สังกัดตาม HR" จึงต้อง update คอลัมน์นั้นเอง — จงใจไม่ไปแก้
//   factory เพราะเทสต์ชุดอื่นพึ่งพาพฤติกรรมเดิม (ไม่มีค่า = ถอยไปใช้บริษัทของแผนก)
describe('ล็อกบริษัทตาม role', () => {
  const setHrCompany = (employeeId: number, companyCode: string) =>
    db.update(employee).set({ companyCode }).where(eq(employee.id, employeeId));

  test('EMPLOYEE ส่งบริษัทอื่นมา → ถูกทิ้ง แล้วบังคับเป็นบริษัทตัวเอง', async () => {
    const mine = await makeDepartment('แผนกของฉัน', 'UBP');
    const ubaDept = await makeDepartment('แผนกของ UBA', 'UBA');
    const emp = await makeEmployee({ departmentId: mine, companyCode: 'UBP' });
    await setHrCompany(emp, 'UBP');
    const userId = await makeUser({ roleName: 'EMPLOYEE', employeeId: emp });

    await makeAsset({ departmentId: mine, companyCode: 'UBP' });
    await makeAsset({ departmentId: ubaDept, companyCode: 'UBA' });

    const res = await dashboardService.overview(asRole(userId, 'EMPLOYEE'), {
      companyCode: 'UBA',
    });

    expect(res.scope.companyCode).toBe('UBP');
    expect(res.scope.companyLocked).toBe(true);
  });

  // ★ ข้อที่ห้ามล้ม — byCompany ถูกส่งออก API ทั้งก้อนพร้อมยอดเงินรายบริษัท
  //   ต่อให้ scope.companyCode ถูกต้องแล้ว ถ้าก้อนนี้ยังมีบริษัทอื่นติดไป ข้อมูลก็รั่วอยู่ดี
  //   (หน้าจอไม่ได้แสดงก็จริง แต่ response ที่ผู้ใช้เปิด devtools ดูได้ก็คือรั่วแล้ว)
  test('byCompany ของคนที่ถูกล็อก ต้องเหลือบริษัทเดียว ไม่ติดยอดเงินบริษัทอื่นไป', async () => {
    const mine = await makeDepartment('แผนกของฉัน', 'UBP');
    const ubaDept = await makeDepartment('แผนกของ UBA', 'UBA');
    const emp = await makeEmployee({ departmentId: mine, companyCode: 'UBP' });
    await setHrCompany(emp, 'UBP');
    const userId = await makeUser({ roleName: 'EMPLOYEE', employeeId: emp });

    await makeAsset({ departmentId: mine, companyCode: 'UBP' });
    const uba = await makeAsset({ departmentId: ubaDept, companyCode: 'UBA' });
    await makeAccounting(uba, { bookedCost: 999_999, accumulatedDepreciation: 0 });

    const res = await dashboardService.overview(asRole(userId, 'EMPLOYEE'), {});

    expect(res.byCompany.map((c) => c.companyCode)).toEqual(['UBP']);
  });

  // รหัสมั่วจากคนที่เลือกไม่ได้อยู่แล้ว ไม่ควรพังทั้งหน้า — ต่างจาก ADMIN ที่ต้องได้ 404
  // (หลักเดียวกับ departmentId ของแผนกอื่นที่ถูกทิ้งเงียบ ๆ ไม่ใช่ 403)
  test('EMPLOYEE ส่งรหัสบริษัทที่ไม่มีจริง → ไม่ 404 แต่ตกไปที่บริษัทตัวเอง', async () => {
    const mine = await makeDepartment('แผนกของฉัน', 'UBP');
    const emp = await makeEmployee({ departmentId: mine, companyCode: 'UBP' });
    await setHrCompany(emp, 'UBP');
    const userId = await makeUser({ roleName: 'EMPLOYEE', employeeId: emp });

    const res = await dashboardService.overview(asRole(userId, 'EMPLOYEE'), {
      companyCode: 'NOPE',
    });

    expect(res.scope.companyCode).toBe('UBP');
  });

  // ★ ลำดับนี้ห้ามสลับ — ข้อมูลจริง 2026-09-03: employee.departmentId ของ 391 จาก 404 คน
  //   ชี้ไปแผนกของ UBA ทั้งที่คนเหล่านั้นสังกัด UBP/MIG (บั๊กเดิมที่ employee_company
  //   ถูกสร้างมาแก้) เอาแผนกขึ้นก่อนเมื่อไหร่ คนเกือบทั้งบริษัทจะถูกล็อกเป็น UBA
  test('สังกัดตาม HR ชนะบริษัทของแผนกที่ผูกไว้', async () => {
    const ubaDept = await makeDepartment('แผนกของ UBA', 'UBA');
    const emp = await makeEmployee({ departmentId: ubaDept, companyCode: 'UBA' });
    await setHrCompany(emp, 'UBP');
    const userId = await makeUser({ roleName: 'EMPLOYEE', employeeId: emp });

    const res = await dashboardService.overview(asRole(userId, 'EMPLOYEE'), {});

    expect(res.scope.companyCode).toBe('UBP');
  });

  // 199 จาก 404 แถวยังไม่มีค่าในคอลัมน์นั้น (วัด 2026-09-03) — ต้องยังบอกบริษัทได้
  // ไม่ใช่ตกไปเป็น null แล้วกลายเป็น "เห็นทุกบริษัท" ซึ่งคือรูที่กำลังปิดอยู่พอดี
  test('ไม่มีสังกัดตาม HR → ถอยไปใช้บริษัทของแผนก', async () => {
    const mine = await makeDepartment('แผนกของฉัน', 'UBP');
    // ไม่เรียก setHrCompany — employee.companyCode เป็น NULL ตามค่าเริ่มต้นของ factory
    const emp = await makeEmployee({ departmentId: mine, companyCode: 'UBP' });
    const userId = await makeUser({ roleName: 'EMPLOYEE', employeeId: emp });

    const res = await dashboardService.overview(asRole(userId, 'EMPLOYEE'), {});

    expect(res.scope.companyCode).toBe('UBP');
    expect(res.scope.companyLocked).toBe(true);
  });

  test.each(['MANAGER', 'FINANCE', 'ADMIN'])('%s ไม่ถูกล็อกบริษัท', async (roleName) => {
    const emp = await makeEmployee({ companyCode: 'UBP' });
    await setHrCompany(emp, 'UBP');
    const userId = await makeUser({ roleName, employeeId: emp });

    await makeAsset({ companyCode: 'UBA' });
    await makeAsset({ companyCode: 'UBP' });

    const res = await dashboardService.overview(asRole(userId, roleName), {});

    expect(res.scope.companyCode).toBeNull();
    expect(res.scope.companyLocked).toBe(false);
    expect(res.totals.assets).toBe(2);
    // ยังเลือกบริษัทอื่นที่ไม่ใช่ของตัวเองได้ตามเดิม
    const picked = await dashboardService.overview(asRole(userId, roleName), {
      companyCode: 'UBA',
    });
    expect(picked.scope.companyCode).toBe('UBA');
    expect(picked.totals.assets).toBe(1);
  });
});

// ═══ byCompany — ทั้งตัวเลขเทียบบริษัทและตัวเลือกใน dropdown ═══
describe('byCompany', () => {
  test('แยกจำนวนและยอดเงินรายบริษัท', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const uba = await makeAsset({ companyCode: 'UBA' });
    await makeAsset({ companyCode: 'UBP' });
    await makeAsset({ companyCode: 'UBP' });
    await makeAccounting(uba, { bookedCost: 1000, accumulatedDepreciation: 400 });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    const byCode = new Map(res.byCompany.map((c) => [c.companyCode, c]));
    expect(byCode.get('UBA')!.assets).toBe(1);
    expect(byCode.get('UBA')!.netBookValue).toBe(600);
    expect(byCode.get('UBP')!.assets).toBe(2);
    // ไม่มีชิ้นไหนของ UBP มีตัวเลขบัญชี → null ไม่ใช่ 0
    expect(byCode.get('UBP')!.netBookValue).toBeNull();
  });

  // ★ ข้อที่ห้ามล้ม — หน้าจอเอา byCompany ไปทำตัวเลือกใน dropdown ถ้าก้อนนี้ถูกกรอง
  //   ตามบริษัทที่เลือก ลิสต์จะยุบเหลือตัวเดียว แล้วผู้ใช้จะกดกลับไปบริษัทอื่นไม่ได้อีกเลย
  test('เลือกบริษัทแล้ว byCompany ต้องยังมีครบทุกบริษัท', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    await makeAsset({ companyCode: 'UBA' });
    await makeAsset({ companyCode: 'UBP' });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), { companyCode: 'UBP' });

    const codes = res.byCompany.map((c) => c.companyCode).sort();
    expect(codes).toEqual(['UBA', 'UBP']);
    // ตัวเลขในก้อนนี้ยังเป็นของจริงรายบริษัท ไม่ได้ถูกกรองให้เหลือแต่ UBP
    expect(res.byCompany.find((c) => c.companyCode === 'UBA')!.assets).toBe(1);
  });

  // 5 ใน 7 บริษัทไม่มี SAP ให้ sync จึงไม่มีทางมีของ — ปล่อยขึ้นหมดจะได้ dropdown ที่มี
  // ตัวเลือกตายอยู่ 5 อัน
  test('บริษัทที่ไม่ได้ต่อ SAP และไม่มีของ ไม่ขึ้นในลิสต์', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    await makeAsset({ companyCode: 'UBA' });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    const codes = res.byCompany.map((c) => c.companyCode);
    expect(codes).toContain('UBA');
    expect(codes).toContain('UBP'); // ต่อ SAP อยู่ ต้องขึ้นแม้ยังไม่มีของ
    expect(codes).not.toContain('MIG');
    expect(codes).not.toContain('KCC');
  });

  test('บริษัทที่ต่อ SAP แต่ยังไม่มีของ ขึ้นเป็น 0 ไม่ใช่หายไป', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    await makeAsset({ companyCode: 'UBA' });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    const ubp = res.byCompany.find((c) => c.companyCode === 'UBP');
    expect(ubp).toBeDefined();
    expect(ubp!.assets).toBe(0);
    expect(ubp!.bookedCost).toBeNull();
  });

  // byCompany ถูกกรองด้วยแผนก (ต่างจากบริษัท) — ไม่งั้นเลือกแผนกแล้วตัวเลขรายบริษัท
  // จะเป็นของทั้งบริษัทซึ่งไม่ตรงกับการ์ดสรุปข้างบน
  test('byCompany ถูกกรองตามแผนกที่เลือก', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const a = await makeDepartment('แผนก ก');
    const b = await makeDepartment('แผนก ข');
    await makeAsset({ departmentId: a, companyCode: 'UBA' });
    await makeAsset({ departmentId: b, companyCode: 'UBA' });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), { departmentId: a });

    expect(res.byCompany.find((c) => c.companyCode === 'UBA')!.assets).toBe(1);
  });
});

// ═══ อายุคงเหลือรายแผนก (remainingLife) ═══
//
// ★ กับดักของชุดนี้คือ 0 มีสองความหมายคนละเรื่อง ขึ้นกับว่าอ่านคู่กับ usefulLifeMonths อะไร
//   usefulLifeMonths = 0    → ไม่คิดค่าเสื่อมเลย (ที่ดิน) ไม่มีวันหมดอายุ
//   remainingLifeMonths = 0 → ตัดค่าเสื่อมครบแล้ว
//   ทั้งคู่มี remainingLifeMonths = 0 เหมือนกันเป๊ะ ถ้าไม่แยกจะนับที่ดินเป็น "ตัดครบแล้ว"
describe('อายุคงเหลือรายแผนก', () => {
  const bucket = (res: Awaited<ReturnType<typeof dashboardService.overview>>, label: string) =>
    res.remainingLife?.buckets.find((b) => b.label === label)?.count;

  test('ไม่เลือกแผนก → ไม่คิดให้ (null)', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const dep = await makeDepartment('แผนก ก');
    const id = await makeAsset({ departmentId: dep });
    await makeAccounting(id, { usefulLifeMonths: 60, remainingLifeMonths: 24 });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {});

    expect(res.remainingLife).toBeNull();
  });

  test('เลือกแผนก → แบ่งช่วงตามอายุคงเหลือ', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const dep = await makeDepartment('แผนก ก');
    for (const months of [6, 12, 13, 30, 40, 55, 90]) {
      const id = await makeAsset({ departmentId: dep });
      await makeAccounting(id, { usefulLifeMonths: 120, remainingLifeMonths: months });
    }

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), { departmentId: dep });

    expect(bucket(res, '1–12 เดือน')).toBe(2); // 6, 12
    expect(bucket(res, '13–24 เดือน')).toBe(1); // 13
    expect(bucket(res, '25–36 เดือน')).toBe(1); // 30
    expect(bucket(res, '37–48 เดือน')).toBe(1); // 40
    expect(bucket(res, '49–60 เดือน')).toBe(1); // 55
    expect(bucket(res, 'เกิน 60 เดือน')).toBe(1); // 90
  });

  // ★ ข้อที่ห้ามล้ม — ที่ดินกับของที่ตัดครบแล้วมีเลขเดียวกันเป๊ะ ต้องไปคนละช่อง
  test('ที่ดิน (ไม่คิดค่าเสื่อม) ไม่ถูกนับเป็น "ตัดครบแล้ว"', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const dep = await makeDepartment('แผนก ก');

    const land = await makeAsset({ departmentId: dep });
    await makeAccounting(land, { usefulLifeMonths: 0, remainingLifeMonths: 0 });

    const done = await makeAsset({ departmentId: dep });
    await makeAccounting(done, { usefulLifeMonths: 60, remainingLifeMonths: 0 });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), { departmentId: dep });

    expect(bucket(res, 'ตัดครบแล้ว')).toBe(1);
    expect(res.remainingLife!.noDepreciation).toBe(1);
  });

  test('ชิ้นที่ไม่มีแถวบัญชี ไปอยู่ noData ไม่ใช่ช่องใดช่องหนึ่ง', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const dep = await makeDepartment('แผนก ก');
    await makeAsset({ departmentId: dep }); // ไม่มีแถวบัญชี
    const id = await makeAsset({ departmentId: dep });
    await makeAccounting(id, { usefulLifeMonths: 60, remainingLifeMonths: 24 });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), { departmentId: dep });

    expect(res.remainingLife!.noData).toBe(1);
    const sum = res.remainingLife!.buckets.reduce((acc, b) => acc + b.count, 0);
    expect(sum).toBe(1);
  });

  // ★ ทุกชิ้นในแผนกต้องถูกนับที่ใดที่หนึ่งพอดีครั้งเดียว ไม่หายไปเฉย ๆ และไม่นับซ้ำ
  test('buckets + noDepreciation + noData รวมกันเท่ากับจำนวนชิ้นในแผนก', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const dep = await makeDepartment('แผนก ก');

    const specs = [
      { useful: 60, remaining: 0 },
      { useful: 60, remaining: 10 },
      { useful: 60, remaining: 70 },
      { useful: 0, remaining: 0 },
      { useful: 60, remaining: null },
    ];
    for (const s of specs) {
      const id = await makeAsset({ departmentId: dep });
      await makeAccounting(id, { usefulLifeMonths: s.useful, remainingLifeMonths: s.remaining });
    }
    await makeAsset({ departmentId: dep }); // ไม่มีแถวบัญชี

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), { departmentId: dep });
    const life = res.remainingLife!;
    const total =
      life.buckets.reduce((acc, b) => acc + b.count, 0) + life.noDepreciation + life.noData;

    expect(res.totals.assets).toBe(6);
    expect(total).toBe(res.totals.assets);
  });

  test('นับเฉพาะแผนกที่เลือก ไม่ปนแผนกอื่น', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const a = await makeDepartment('แผนก ก');
    const b = await makeDepartment('แผนก ข');

    const mine = await makeAsset({ departmentId: a });
    await makeAccounting(mine, { usefulLifeMonths: 60, remainingLifeMonths: 10 });
    const other = await makeAsset({ departmentId: b });
    await makeAccounting(other, { usefulLifeMonths: 60, remainingLifeMonths: 10 });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), { departmentId: a });

    expect(bucket(res, '1–12 เดือน')).toBe(1);
  });

  // แผนกชื่อเดียวกันสองบริษัทเป็นของจริง (55 ชื่อซ้ำกันข้ามบริษัทใน ams_db) — และตั้งแต่
  // 0026 ชิ้นต้องอยู่แผนกของบริษัทตัวเอง จึงต้องเป็นสองแถวคนละ id ไม่ใช่แถวเดียวใช้ร่วม
  test('กรองบริษัทด้วยแล้วยังตัดกันถูก', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const depUba = await makeDepartment('แผนก ก');
    const depUbp = await makeDepartment('แผนก ก', 'UBP');

    const uba = await makeAsset({ departmentId: depUba, companyCode: 'UBA' });
    await makeAccounting(uba, { usefulLifeMonths: 60, remainingLifeMonths: 10 });
    const ubp = await makeAsset({ departmentId: depUbp, companyCode: 'UBP' });
    await makeAccounting(ubp, { usefulLifeMonths: 60, remainingLifeMonths: 10 });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'), {
      departmentId: depUbp,
      companyCode: 'UBP',
    });

    expect(bucket(res, '1–12 เดือน')).toBe(1);
  });
});
