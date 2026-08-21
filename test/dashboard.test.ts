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
import { asset, assetAccounting, department } from '@intrastucture/db/schema';
import * as dashboardService from '@modules/business/dashboard/dashboard.service';
import { makeDepartment, makeEmployee, makeLocation, makeUser, resetDb } from './helpers/factory';

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
  lifecycle?: Lifecycle;
  status?: Status;
  deleted?: boolean;
}): Promise<number> {
  const [row] = await db
    .insert(asset)
    .values({
      origin: 'SAP_LEGACY',
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
  } = {},
) {
  await db.insert(assetAccounting).values({
    assetId,
    fiscalYear: over.fiscalYear ?? new Date().getFullYear(),
    bookedCost: over.bookedCost === undefined ? 1000 : over.bookedCost,
    accumulatedDepreciation:
      over.accumulatedDepreciation === undefined ? 400 : over.accumulatedDepreciation,
    salvageValue: 1,
    usefulLifeMonths: 60,
    remainingLifeMonths: 12,
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

    const res = await dashboardService.overview(asRole(userId, 'EMPLOYEE'));

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

    const res = await dashboardService.overview(asRole(userId, role));

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

    const res = await dashboardService.overview(asRole(userId, 'EMPLOYEE'));

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

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'));
    expect(res.totals.assets).toBe(1);
  });

  test('ชิ้นที่ยังไม่ระบุแผนก โผล่เป็นแถวของตัวเองในสรุปรายแผนก (ยอดรวมถึงจะลงตัว)', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const dep = await makeDepartment('แผนก A');

    await makeAsset({ departmentId: dep });
    await makeAsset({ departmentId: null });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'));

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

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'));

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

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'));

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

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'));

    expect(res.byDepartment.find((d) => d.departmentId === closed)?.assets).toBe(2);
    expect(res.byDepartment.reduce((sum, d) => sum + d.assets, 0)).toBe(res.totals.assets);
  });

  test('แผนกที่ปิดใช้งานและไม่มีของ ไม่ต้องโผล่ (ไม่มีอะไรให้ดู)', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const closed = await makeDepartment('แผนกที่ยุบและว่าง');
    await db.update(department).set({ isActive: false }).where(eq(department.id, closed));

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'));

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

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'));

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

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'));

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

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'));

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

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'));

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

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'));

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

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'));

    expect(res.totals.valued).toBe(1);
    expect(res.totals.accumulatedDepreciation).toBe(0);
    expect(res.totals.netBookValue).toBe(28800000);
  });
});

describe('สถานะ active/inactive', () => {
  test('active คือ Active ล้วน ที่เหลือรวมเป็น inactive', async () => {
    const userId = await makeUser({ roleName: 'ADMIN' });
    const dep = await makeDepartment();

    await makeAsset({ departmentId: dep, status: 'Active' });
    await makeAsset({ departmentId: dep, status: 'Active' });
    await makeAsset({ departmentId: dep, status: 'Active' });
    await makeAsset({ departmentId: dep, status: 'Inactive' });
    await makeAsset({ departmentId: dep, status: 'Under Maintenance' });

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'));

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

    const res = await dashboardService.overview(asRole(userId, 'ADMIN'));

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

    const res = await dashboardService.overview(asRole(userId, 'FINANCE'));

    expect(res.freshness.fiscalYear).toBe(thisYear);
    expect(res.freshness.currentYearCount).toBe(1);
    expect(res.freshness.staleCount).toBe(2);
    expect(res.freshness.noDataCount).toBe(1);
  });
});
