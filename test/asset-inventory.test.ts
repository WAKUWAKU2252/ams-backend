// ═══ GET /assets/inventory — ทะเบียนสินทรัพย์ทั้งบริษัท (หน้า Asset Inventory) ═══
//
// สามเรื่องที่เทสต์นี้เฝ้า:
//
// 1. **ขอบเขตของหน้า** — เฉพาะชิ้นที่ลงทะเบียนแล้วและยังไม่ถูกลบ ของที่ยังไม่ออกเลข
//    (DRAFT) ต้องไม่หลุดเข้ามา เพราะไม่มีเลขให้ค้นและกดเข้าไปดูรายละเอียดไม่ได้
//
// 2. **การแบ่งหน้าต้องนิ่ง** — total ต้องเป็นยอดของทั้งชุดที่กรองแล้ว ไม่ใช่จำนวนแถวในหน้า
//    และลำดับต้องคงที่ข้ามหน้า ไม่งั้นผู้ใช้จะเห็นชิ้นเดิมซ้ำในหน้าถัดไปและมีบางชิ้นหายไป
//
// 3. **ค้นแล้วต้องเจอจากสิ่งที่คนจำได้จริง** — เลขทะเบียน / ชื่อของ / เลขเครื่อง
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '@intrastucture/db';
import { asset, assetAccounting } from '@intrastucture/db/schema';
import * as assetService from '@modules/business/asset/asset.service';
import {
  makeDepartment,
  makeEmployee,
  makeLocation,
  makeSubLocation,
  resetDb,
  TEST_COMPANY,
} from './helpers/factory';

let locationId = 0;

async function makeAsset(opts: {
  assetNumber: string;
  description?: string;
  serialNumber?: string | null;
  departmentId?: number | null;
  employeeId?: number | null;
  lifecycle?: 'DRAFT' | 'REGISTERED' | 'CANCELLED';
  deleted?: boolean;
  /** ไม่ระบุ = TEST_COMPANY (UBA) — migration 0021 seed ทั้ง UBA และ UBP ไว้แล้ว */
  companyCode?: string;
  /** ไม่ระบุ = สถานที่กลางที่สร้างไว้ใน beforeEach */
  locationId?: number;
  /** วันที่ลงทะเบียนใน SAP (OITM.CreateDate) — null = ยังไม่มีแถวใน OITM */
  sapCreatedDate?: string | null;
  status?: 'Active' | 'Inactive' | 'Under Maintenance' | 'Lost' | 'Disposed';
}): Promise<number> {
  const [row] = await db
    .insert(asset)
    .values({
      origin: 'SAP_LEGACY',
      companyCode: opts.companyCode ?? TEST_COMPANY,
      assetNumber: opts.assetNumber,
      description: opts.description ?? 'ของทดสอบ',
      serialNumber: opts.serialNumber ?? null,
      locationId: opts.locationId ?? locationId,
      departmentId: opts.departmentId ?? null,
      employeeId: opts.employeeId ?? null,
      lifecycle: opts.lifecycle ?? 'REGISTERED',
      status: opts.status ?? 'Active',
      sapCreatedDate: opts.sapCreatedDate ?? null,
      deletedAt: opts.deleted ? new Date().toISOString() : null,
    })
    .returning();
  return row!.id;
}

/** แถวบัญชีของชิ้นนั้น — assetId เป็น primary key จึงมีได้ชิ้นละแถวเดียว */
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
  });
}

const list = (over: Partial<Parameters<typeof assetService.findInventory>[0]> = {}) =>
  assetService.findInventory({ page: 1, limit: 20, ...over });

beforeEach(async () => {
  await resetDb();
  locationId = await makeLocation();
});

describe('ขอบเขตของหน้า', () => {
  test('เห็นเฉพาะชิ้นที่ลงทะเบียนแล้วและยังไม่ถูกลบ', async () => {
    await makeAsset({ assetNumber: 'COM-100-05-001' });
    await makeAsset({ assetNumber: 'COM-100-05-002', lifecycle: 'DRAFT' });
    await makeAsset({ assetNumber: 'COM-100-05-003', lifecycle: 'CANCELLED' });
    await makeAsset({ assetNumber: 'COM-100-05-004', deleted: true });

    const res = await list();

    expect(res.total).toBe(1);
    expect(res.data.map((d) => d.assetNumber)).toEqual(['COM-100-05-001']);
  });

  // ★ ไม่จำกัดตามคนที่ล็อกอิน — หน้านี้ตอบว่า "ของอยู่ไหน" ให้ทุกคน ไม่ใช่ "ของฉัน"
  //   ถ้าวันหลังมีใครใส่เงื่อนไขผูกกับ user เข้ามา เทสต์นี้จะจับได้
  test('เห็นของทุกแผนก ไม่ผูกกับผู้ถือครองคนใดคนหนึ่ง', async () => {
    const depA = await makeDepartment('แผนก A');
    const depB = await makeDepartment('แผนก B');
    const empA = await makeEmployee({ departmentId: depA });

    await makeAsset({ assetNumber: 'A-001', departmentId: depA, employeeId: empA });
    await makeAsset({ assetNumber: 'B-001', departmentId: depB });
    await makeAsset({ assetNumber: 'C-001', departmentId: null });

    const res = await list();
    expect(res.total).toBe(3);
  });
});

describe('ค้นหา', () => {
  beforeEach(async () => {
    await makeAsset({
      assetNumber: 'MAC-212-13-001',
      description: 'เครื่องกลึงอัตโนมัติ',
      serialNumber: 'SN-ALPHA-99',
    });
    await makeAsset({
      assetNumber: 'COM-100-05-777',
      description: 'โน้ตบุ๊กสำนักงาน',
      serialNumber: 'SN-BETA-11',
    });
  });

  test('ค้นด้วยเลขสินทรัพย์', async () => {
    const res = await list({ search: '212-13' });
    expect(res.data.map((d) => d.assetNumber)).toEqual(['MAC-212-13-001']);
  });

  test('ค้นด้วยรายละเอียด', async () => {
    const res = await list({ search: 'โน้ตบุ๊ก' });
    expect(res.data.map((d) => d.assetNumber)).toEqual(['COM-100-05-777']);
  });

  test('ค้นด้วยเลขเครื่อง (S/N)', async () => {
    const res = await list({ search: 'ALPHA' });
    expect(res.data.map((d) => d.assetNumber)).toEqual(['MAC-212-13-001']);
  });

  test('ค้นไม่สนตัวพิมพ์เล็กใหญ่', async () => {
    const res = await list({ search: 'sn-beta' });
    expect(res.data.map((d) => d.assetNumber)).toEqual(['COM-100-05-777']);
  });

  test('ค้นไม่เจอ = ลิสต์ว่าง total 0 (ไม่ใช่คืนทั้งหมด)', async () => {
    const res = await list({ search: 'ไม่มีอะไรชื่อนี้' });
    expect(res.total).toBe(0);
    expect(res.data).toHaveLength(0);
  });

  test('เว้นวรรคล้วนถือว่าไม่ได้ค้น — คืนทั้งหมด', async () => {
    const res = await list({ search: '   ' });
    expect(res.total).toBe(2);
  });
});

describe('กรองตามแผนก', () => {
  test('เอาเฉพาะแผนกที่เลือก', async () => {
    const depA = await makeDepartment('แผนก A');
    const depB = await makeDepartment('แผนก B');

    await makeAsset({ assetNumber: 'A-001', departmentId: depA });
    await makeAsset({ assetNumber: 'A-002', departmentId: depA });
    await makeAsset({ assetNumber: 'B-001', departmentId: depB });
    await makeAsset({ assetNumber: 'N-001', departmentId: null });

    const res = await list({ departmentId: depA });

    expect(res.total).toBe(2);
    expect(res.data.map((d) => d.assetNumber)).toEqual(['A-001', 'A-002']);
    expect(res.data[0]!.departmentName).toBe('แผนก A');
  });

  test('กรองแผนกใช้ร่วมกับค้นหาได้', async () => {
    const depA = await makeDepartment('แผนก A');
    const depB = await makeDepartment('แผนก B');

    await makeAsset({ assetNumber: 'A-001', description: 'เครื่องพิมพ์', departmentId: depA });
    await makeAsset({ assetNumber: 'B-001', description: 'เครื่องพิมพ์', departmentId: depB });

    const res = await list({ departmentId: depA, search: 'เครื่องพิมพ์' });

    expect(res.total).toBe(1);
    expect(res.data[0]!.assetNumber).toBe('A-001');
  });
});

describe('การเรียงลำดับ', () => {
  test('ไม่ส่ง sort — เรียงตามเลขสินทรัพย์เหมือนเดิม', async () => {
    await makeAsset({ assetNumber: 'C-003' });
    await makeAsset({ assetNumber: 'A-001' });
    await makeAsset({ assetNumber: 'B-002' });

    const res = await list();

    expect(res.data.map((r) => r.assetNumber)).toEqual(['A-001', 'B-002', 'C-003']);
  });

  test('เรียงตามวันที่ลงทะเบียน — ใหม่สุดขึ้นก่อน', async () => {
    await makeAsset({ assetNumber: 'A-001', sapCreatedDate: '2020-01-01' });
    await makeAsset({ assetNumber: 'A-002', sapCreatedDate: '2026-08-31' });
    await makeAsset({ assetNumber: 'A-003', sapCreatedDate: '2017-04-04' });

    const res = await list({ sort: 'registered' });

    expect(res.data.map((r) => r.assetNumber)).toEqual(['A-002', 'A-001', 'A-003']);
  });

  test('ชิ้นที่ยังไม่มีวันลงทะเบียนไปอยู่ท้ายสุด ไม่ใช่ขึ้นหัว', async () => {
    await makeAsset({ assetNumber: 'A-001', sapCreatedDate: null });
    await makeAsset({ assetNumber: 'A-002', sapCreatedDate: '2020-01-01' });

    const res = await list({ sort: 'registered' });

    expect(res.data.map((r) => r.assetNumber)).toEqual(['A-002', 'A-001']);
  });

  test('เรียงตามมูลค่าคงเหลือ — มากสุดขึ้นก่อน และชิ้นที่คำนวณไม่ได้ไปท้าย', async () => {
    const cheap = await makeAsset({ assetNumber: 'A-001' });
    const rich = await makeAsset({ assetNumber: 'A-002' });
    await makeAsset({ assetNumber: 'A-003' }); // ไม่มีแถวบัญชี = คำนวณ NBV ไม่ได้
    await makeAccounting(cheap, { bookedCost: 1000, accumulatedDepreciation: 900 }); // 100
    await makeAccounting(rich, { bookedCost: 5000, accumulatedDepreciation: 1000 }); // 4000

    const res = await list({ sort: 'netBookValue' });

    expect(res.data.map((r) => r.assetNumber)).toEqual(['A-002', 'A-001', 'A-003']);
  });

  test('เรียงตามปีบัญชี — ปีใหม่สุดขึ้นก่อน', async () => {
    const old = await makeAsset({ assetNumber: 'A-001' });
    const recent = await makeAsset({ assetNumber: 'A-002' });
    await makeAccounting(old, { fiscalYear: 2022 });
    await makeAccounting(recent, { fiscalYear: 2026 });

    const res = await list({ sort: 'fiscalYear' });

    expect(res.data.map((r) => r.assetNumber)).toEqual(['A-002', 'A-001']);
  });

  test('สลับทิศเป็นน้อยไปมาก — เก่าสุดขึ้นก่อน', async () => {
    await makeAsset({ assetNumber: 'A-001', sapCreatedDate: '2020-01-01' });
    await makeAsset({ assetNumber: 'A-002', sapCreatedDate: '2026-08-31' });
    await makeAsset({ assetNumber: 'A-003', sapCreatedDate: '2017-04-04' });

    const res = await list({ sort: 'registered', sortDir: 'asc' });

    expect(res.data.map((r) => r.assetNumber)).toEqual(['A-003', 'A-001', 'A-002']);
  });

  test('สลับทิศแล้ว NULL ยังอยู่ท้ายสุด ไม่ใช่ขึ้นหัว', async () => {
    await makeAsset({ assetNumber: 'A-001', sapCreatedDate: null });
    await makeAsset({ assetNumber: 'A-002', sapCreatedDate: '2020-01-01' });

    const res = await list({ sort: 'registered', sortDir: 'asc' });

    expect(res.data.map((r) => r.assetNumber)).toEqual(['A-002', 'A-001']);
  });

  test('สลับทิศของมูลค่าคงเหลือ — ถูกสุดขึ้นก่อน', async () => {
    const cheap = await makeAsset({ assetNumber: 'A-001' });
    const rich = await makeAsset({ assetNumber: 'A-002' });
    await makeAccounting(cheap, { bookedCost: 1000, accumulatedDepreciation: 900 });
    await makeAccounting(rich, { bookedCost: 5000, accumulatedDepreciation: 1000 });

    const res = await list({ sort: 'netBookValue', sortDir: 'asc' });

    expect(res.data.map((r) => r.assetNumber)).toEqual(['A-001', 'A-002']);
  });

  test('ไม่ส่ง sortDir = มาก/ใหม่ก่อน (ค่าตั้งต้น)', async () => {
    await makeAsset({ assetNumber: 'A-001', sapCreatedDate: '2020-01-01' });
    await makeAsset({ assetNumber: 'A-002', sapCreatedDate: '2026-08-31' });

    const res = await list({ sort: 'registered' });

    expect(res.data[0]!.assetNumber).toBe('A-002');
  });

  test('เรียงลำดับใช้ร่วมกับตัวกรองได้ — เรียงเฉพาะของที่ผ่านตัวกรอง', async () => {
    await makeAsset({ assetNumber: 'A-001', status: 'Lost', sapCreatedDate: '2020-01-01' });
    await makeAsset({ assetNumber: 'A-002', status: 'Active', sapCreatedDate: '2026-01-01' });
    await makeAsset({ assetNumber: 'A-003', status: 'Lost', sapCreatedDate: '2024-01-01' });

    const res = await list({ sort: 'registered', status: 'Lost' });

    expect(res.total).toBe(2);
    expect(res.data.map((r) => r.assetNumber)).toEqual(['A-003', 'A-001']);
  });

  test('ลำดับคงที่ข้ามหน้าเมื่อค่าที่เรียงเท่ากันทั้งชุด (ลงทะเบียนวันเดียวกันเป็นล็อต)', async () => {
    for (let i = 1; i <= 6; i++) {
      await makeAsset({ assetNumber: `A-${String(i).padStart(3, '0')}`, sapCreatedDate: '2017-04-04' });
    }

    const p1 = await list({ sort: 'registered', page: 1, limit: 3 });
    const p2 = await list({ sort: 'registered', page: 2, limit: 3 });
    const seen = [...p1.data, ...p2.data].map((r) => r.assetNumber);

    expect(new Set(seen).size).toBe(6);
  });
});

describe('การแบ่งหน้า', () => {
  beforeEach(async () => {
    // เลขเรียงได้แน่นอน (001..025) เพื่อตรวจลำดับข้ามหน้าได้จริง
    for (let i = 1; i <= 25; i++) {
      await makeAsset({ assetNumber: `INV-${String(i).padStart(3, '0')}` });
    }
  });

  test('total เป็นยอดทั้งชุด ไม่ใช่จำนวนแถวในหน้า', async () => {
    const res = await list({ page: 1, limit: 10 });

    expect(res.total).toBe(25);
    expect(res.data).toHaveLength(10);
    expect(res.page).toBe(1);
    expect(res.limit).toBe(10);
  });

  test('หน้าสุดท้ายได้เศษที่เหลือ', async () => {
    const res = await list({ page: 3, limit: 10 });

    expect(res.total).toBe(25);
    expect(res.data).toHaveLength(5);
    expect(res.data[0]!.assetNumber).toBe('INV-021');
  });

  // ★ ชิ้นเดียวกันต้องไม่โผล่สองหน้า และต้องไม่มีชิ้นไหนหายไประหว่างหน้า
  test('ไล่ทุกหน้าแล้วได้ครบ 25 ชิ้นโดยไม่ซ้ำ', async () => {
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const res = await list({ page, limit: 10 });
      seen.push(...res.data.map((d) => d.assetNumber));
    }

    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  test('หน้าที่เลยจากข้อมูล → ว่าง แต่ total ยังบอกยอดจริง', async () => {
    const res = await list({ page: 99, limit: 10 });

    expect(res.data).toHaveLength(0);
    expect(res.total).toBe(25);
  });

  test('ค้นแล้ว total ต้องเป็นยอดของผลค้น ไม่ใช่ยอดทั้งทะเบียน', async () => {
    const res = await list({ search: 'INV-01', limit: 5 });

    // INV-010..INV-019 = 10 ชิ้น
    expect(res.total).toBe(10);
    expect(res.data).toHaveLength(5);
  });
});

describe('ข้อมูลในแถว', () => {
  test('ประกอบชื่อผู้ถือครอง/ตำแหน่งย่อย และมูลค่าคงเหลือให้พร้อมแสดง', async () => {
    const dep = await makeDepartment('แผนกช่าง');
    const emp = await makeEmployee({ departmentId: dep });
    const id = await makeAsset({
      assetNumber: 'MAC-001',
      description: 'เครื่องกลึง',
      departmentId: dep,
      employeeId: emp,
    });
    await db.insert(assetAccounting).values({
      assetId: id,
      fiscalYear: 2026,
      bookedCost: 12871.03,
      accumulatedDepreciation: 12870.03,
    });

    const res = await list();
    const row = res.data[0]!;

    expect(row.departmentName).toBe('แผนกช่าง');
    // factory ตั้งชื่อไทยเป็น "ทดสอบ <สุ่ม>" — เช็คว่าประกอบจาก firstName + lastName จริง
    // (ไม่ใช่ตกไป fallback รหัสพนักงานหรือคืนค่าว่าง)
    expect(row.holderName).toMatch(/^ทดสอบ \S+$/);
    expect(row.accounting?.fiscalYear).toBe(2026);
    expect(row.accounting?.netBookValue).toBeCloseTo(1, 2);
  });

  test('ไม่มีผู้ถือครอง/ไม่มีแผนก → null ไม่ใช่สตริงว่าง', async () => {
    await makeAsset({ assetNumber: 'MAC-002', departmentId: null, employeeId: null });

    const row = (await list()).data[0]!;

    expect(row.holderName).toBeNull();
    expect(row.departmentName).toBeNull();
    expect(row.subLocationName).toBeNull();
  });

  // ยอดที่คำนวณไม่ได้ต้องเป็น null ห้ามเดาเป็น 0 — 0 แปลว่าตัดค่าเสื่อมครบแล้ว คนละเรื่อง
  test('มีแถวบัญชีแต่ตัวเลขไม่ครบ → netBookValue เป็น null แต่ยังบอกปีได้', async () => {
    const id = await makeAsset({ assetNumber: 'MAC-003' });
    await db.insert(assetAccounting).values({
      assetId: id,
      fiscalYear: 2022,
      bookedCost: null,
      accumulatedDepreciation: 500,
    });

    const row = (await list()).data[0]!;

    expect(row.accounting?.fiscalYear).toBe(2022);
    expect(row.accounting?.netBookValue).toBeNull();
  });

  test('ไม่มีแถวบัญชีเลย → accounting เป็น null ทั้งก้อน', async () => {
    await makeAsset({ assetNumber: 'MAC-004' });

    expect((await list()).data[0]!.accounting).toBeNull();
  });
});

// ═══ กรองตามบริษัท ═══
//
// ตารางบน Dashboard ส่ง companyCode มาให้ตรงกับการ์ดสรุปข้างบน ถ้าเส้นนี้ไม่รับ
// การ์ดจะบอกยอดของ UBP แต่ตารางไล่ของ UBA มาให้ดู
describe('กรองตามบริษัท', () => {
  test('ไม่ส่ง companyCode → ได้ทุกบริษัท', async () => {
    await makeAsset({ assetNumber: 'A-001', companyCode: 'UBA' });
    await makeAsset({ assetNumber: 'A-002', companyCode: 'UBP' });

    const res = await assetService.findInventory({ page: 1, limit: 20 });

    expect(res.total).toBe(2);
  });

  test('ส่ง companyCode → ได้เฉพาะบริษัทนั้น', async () => {
    await makeAsset({ assetNumber: 'A-001', companyCode: 'UBA' });
    await makeAsset({ assetNumber: 'A-002', companyCode: 'UBP' });
    await makeAsset({ assetNumber: 'A-003', companyCode: 'UBP' });

    const res = await assetService.findInventory({ page: 1, limit: 20, companyCode: 'UBP' });

    expect(res.total).toBe(2);
    expect(res.data.every((r) => r.companyCode === 'UBP')).toBe(true);
  });

  // เลขสินทรัพย์ซ้ำกันข้ามบริษัทได้จริง (วัดจาก OITM 24 ตัว) — กรองบริษัทแล้วต้องเหลือชิ้นเดียว
  test('เลขซ้ำข้ามบริษัท กรองบริษัทแล้วเหลือชิ้นเดียว', async () => {
    await makeAsset({ assetNumber: 'DUP-001', companyCode: 'UBA' });
    await makeAsset({ assetNumber: 'DUP-001', companyCode: 'UBP' });

    const all = await assetService.findInventory({ page: 1, limit: 20, search: 'DUP-001' });
    const ubp = await assetService.findInventory({
      page: 1,
      limit: 20,
      search: 'DUP-001',
      companyCode: 'UBP',
    });

    expect(all.total).toBe(2);
    expect(ubp.total).toBe(1);
    expect(ubp.data[0]!.companyCode).toBe('UBP');
  });

  // ★ แผนกต้องเป็นของบริษัทเดียวกับชิ้นตั้งแต่ 0026 (fk_asset_department เป็นคีย์คู่)
  //   ชื่อแผนกซ้ำข้ามบริษัทได้ตามปกติ แต่เป็นคนละแถวคนละ id — ตรงกับของจริงใน ams_db
  //   ที่มีชื่อซ้ำกัน 55 ชื่อ ตัวกรองสองแกนจึงต้องยังตัดกันถูกแม้ชื่อจะเหมือนกัน
  test('กรองบริษัทกับกรองแผนกตัดกันทั้งสองแกน', async () => {
    const depUba = await makeDepartment('แผนกทดสอบ');
    const depUbp = await makeDepartment('แผนกทดสอบ', 'UBP');
    await makeAsset({ assetNumber: 'A-001', companyCode: 'UBA', departmentId: depUba });
    await makeAsset({ assetNumber: 'A-002', companyCode: 'UBP', departmentId: depUbp });
    await makeAsset({ assetNumber: 'A-003', companyCode: 'UBP', departmentId: null });

    const res = await assetService.findInventory({
      page: 1,
      limit: 20,
      departmentId: depUbp,
      companyCode: 'UBP',
    });

    expect(res.total).toBe(1);
    expect(res.data[0]!.assetNumber).toBe('A-002');
  });

  // รหัสที่ไม่มีจริงคืนว่าง ไม่ throw — ต่างจาก /dashboard/overview ที่ 404
  // ที่นี่เป็นตัวกรองของตารางค้นหา ผลว่างอ่านถูกอยู่แล้ว (ดูคอมเมนต์ที่ assetInventoryQuery)
  test('companyCode ที่ไม่มีจริง → ผลว่าง ไม่ใช่ error', async () => {
    await makeAsset({ assetNumber: 'A-001', companyCode: 'UBA' });

    const res = await assetService.findInventory({ page: 1, limit: 20, companyCode: 'NOPE' });

    expect(res.total).toBe(0);
    expect(res.data).toEqual([]);
  });
});

// ═══ ตัวกรองของหน้าทะเบียน: ที่ตั้ง / สถานะ / ปีบัญชี / ช่วงมูลค่าคงเหลือ ═══
//
// ★ สองตัวหลังอ้างถึงคอลัมน์ของตาราง asset_accounting ซึ่งคิวรี "นับ" ต้อง join ด้วย
//   ไม่งั้น total จะพังทั้งที่ตารางยังมาปกติ — เทสต์ที่ตรวจ total คู่กับ data.length
//   ทุกข้อในชุดนี้มีไว้จับอาการนั้นโดยเฉพาะ
describe('ตัวกรองหน้าทะเบียน', () => {
  test('กรองตามที่ตั้ง', async () => {
    const other = await makeLocation();
    await makeAsset({ assetNumber: 'A-001' });
    await makeAsset({ assetNumber: 'A-002' });
    await makeAsset({ assetNumber: 'A-003', locationId: other });

    const res = await assetService.findInventory({ page: 1, limit: 20, locationId: other });

    expect(res.total).toBe(1);
    expect(res.data[0]!.assetNumber).toBe('A-003');
  });

  test('กรองตามสถานะ', async () => {
    await makeAsset({ assetNumber: 'A-001', status: 'Active' });
    await makeAsset({ assetNumber: 'A-002', status: 'Lost' });
    await makeAsset({ assetNumber: 'A-003', status: 'Lost' });

    const res = await assetService.findInventory({ page: 1, limit: 20, status: 'Lost' });

    expect(res.total).toBe(2);
    expect(res.data.every((r) => r.status === 'Lost')).toBe(true);
  });

  test('กรองตามผู้ถือครอง', async () => {
    const somchai = await makeEmployee();
    const somsri = await makeEmployee();
    await makeAsset({ assetNumber: 'A-001', employeeId: somchai });
    await makeAsset({ assetNumber: 'A-002', employeeId: somsri });
    // ไม่มีผู้ถือครอง — ต้องไม่หลุดเข้ามาในผลของการกรองคนใดคนหนึ่ง
    await makeAsset({ assetNumber: 'A-003' });

    const res = await list({ employeeId: somchai });

    expect(res.total).toBe(1);
    expect(res.data[0]!.assetNumber).toBe('A-001');
  });

  test('กรองผู้ถือครองใช้ร่วมกับกรองสถานะได้ — ตัดกันทั้งสองแกน', async () => {
    const somchai = await makeEmployee();
    const somsri = await makeEmployee();
    await makeAsset({ assetNumber: 'A-001', employeeId: somchai, status: 'Active' });
    await makeAsset({ assetNumber: 'A-002', employeeId: somchai, status: 'Lost' });
    await makeAsset({ assetNumber: 'A-003', employeeId: somsri, status: 'Lost' });

    const res = await list({ employeeId: somchai, status: 'Lost' });

    expect(res.total).toBe(1);
    expect(res.data[0]!.assetNumber).toBe('A-002');
  });

  test('กรองตามปีบัญชี', async () => {
    const a = await makeAsset({ assetNumber: 'A-001' });
    const b = await makeAsset({ assetNumber: 'A-002' });
    await makeAccounting(a, { fiscalYear: 2026 });
    await makeAccounting(b, { fiscalYear: 2022 });

    const res = await assetService.findInventory({ page: 1, limit: 20, fiscalYear: 2022 });

    expect(res.total).toBe(1);
    expect(res.data[0]!.assetNumber).toBe('A-002');
  });

  // ★ ชิ้นที่ไม่มีแถวบัญชีต้องหลุดออกจากผล — "ขอของที่ตัวเลขเป็นปี 2026" กับ
  //   "ของที่ไม่มีตัวเลขเลย" คนละคำถาม เอามาปนกันจะอ่านยอดผิด
  test('กรองปีบัญชีแล้ว ชิ้นที่ไม่มีตัวเลขบัญชีต้องไม่อยู่ในผล', async () => {
    const a = await makeAsset({ assetNumber: 'A-001' });
    await makeAsset({ assetNumber: 'A-002' }); // ไม่มีแถวบัญชี
    await makeAccounting(a, { fiscalYear: 2026 });

    const res = await assetService.findInventory({ page: 1, limit: 20, fiscalYear: 2026 });

    expect(res.total).toBe(1);
    expect(res.data).toHaveLength(1);
    expect(res.data[0]!.assetNumber).toBe('A-001');
  });

  test('กรองช่วงมูลค่าคงเหลือ — ขอบเขตนับรวมทั้งสองฝั่ง', async () => {
    const a = await makeAsset({ assetNumber: 'A-001' });
    const b = await makeAsset({ assetNumber: 'A-002' });
    const c = await makeAsset({ assetNumber: 'A-003' });
    await makeAccounting(a, { bookedCost: 1000, accumulatedDepreciation: 900 }); // NBV 100
    await makeAccounting(b, { bookedCost: 1000, accumulatedDepreciation: 500 }); // NBV 500
    await makeAccounting(c, { bookedCost: 1000, accumulatedDepreciation: 100 }); // NBV 900

    const res = await assetService.findInventory({
      page: 1,
      limit: 20,
      minNetBookValue: 100,
      maxNetBookValue: 500,
    });

    expect(res.total).toBe(2);
    expect(res.data.map((r) => r.assetNumber).sort()).toEqual(['A-001', 'A-002']);
  });

  test('ระบุแค่ขอบล่าง', async () => {
    const a = await makeAsset({ assetNumber: 'A-001' });
    const b = await makeAsset({ assetNumber: 'A-002' });
    await makeAccounting(a, { bookedCost: 1000, accumulatedDepreciation: 900 }); // NBV 100
    await makeAccounting(b, { bookedCost: 1000, accumulatedDepreciation: 100 }); // NBV 900

    const res = await assetService.findInventory({ page: 1, limit: 20, minNetBookValue: 500 });

    expect(res.total).toBe(1);
    expect(res.data[0]!.assetNumber).toBe('A-002');
  });

  // 0 ต้องกรองได้จริง ไม่ใช่ถูกมองเป็น "ไม่ได้ส่งค่ามา" — ของที่ตัดค่าเสื่อมครบแล้ว
  // NBV เป็น 0 พอดี และเป็นชุดที่บัญชีถามถึงบ่อย
  test('ขอบเขต 0 ใช้ได้ ไม่ถูกกลืนเป็นค่าว่าง', async () => {
    const a = await makeAsset({ assetNumber: 'A-001' });
    const b = await makeAsset({ assetNumber: 'A-002' });
    await makeAccounting(a, { bookedCost: 1000, accumulatedDepreciation: 1000 }); // NBV 0
    await makeAccounting(b, { bookedCost: 1000, accumulatedDepreciation: 400 }); // NBV 600

    const res = await assetService.findInventory({ page: 1, limit: 20, maxNetBookValue: 0 });

    expect(res.total).toBe(1);
    expect(res.data[0]!.assetNumber).toBe('A-001');
  });

  // SAP ให้มาไม่ครบ = คำนวณ NBV ไม่ได้ = เทียบกับช่วงไม่ได้ ต้องหลุดออกจากผล
  test('ชิ้นที่ตัวเลขบัญชีไม่ครบ ไม่อยู่ในผลของการกรองช่วงมูลค่า', async () => {
    const a = await makeAsset({ assetNumber: 'A-001' });
    const b = await makeAsset({ assetNumber: 'A-002' });
    await makeAccounting(a, { bookedCost: 1000, accumulatedDepreciation: 400 });
    await makeAccounting(b, { bookedCost: 1000, accumulatedDepreciation: null });

    const res = await assetService.findInventory({
      page: 1,
      limit: 20,
      minNetBookValue: -999999,
      maxNetBookValue: 999999,
    });

    expect(res.total).toBe(1);
    expect(res.data[0]!.assetNumber).toBe('A-001');
  });

  // ★ ข้อที่จับบั๊ก "ลืม join ในคิวรีนับ" ได้ตรงที่สุด — total ต้องเท่ากับจำนวนแถวจริง
  test('total ตรงกับจำนวนแถวเมื่อกรองด้วยเงื่อนไขของตารางบัญชี', async () => {
    for (let i = 1; i <= 5; i++) {
      const id = await makeAsset({ assetNumber: `A-00${i}` });
      await makeAccounting(id, {
        fiscalYear: i <= 3 ? 2026 : 2022,
        bookedCost: 1000,
        accumulatedDepreciation: 500,
      });
    }

    const res = await assetService.findInventory({ page: 1, limit: 20, fiscalYear: 2026 });

    expect(res.total).toBe(3);
    expect(res.data).toHaveLength(res.total);
  });

  test('ตัวกรองหลายตัวตัดกันทุกแกน', async () => {
    const dep = await makeDepartment('แผนกทดสอบ');
    const loc = await makeLocation();

    const hit = await makeAsset({
      assetNumber: 'HIT-001',
      departmentId: dep,
      locationId: loc,
      status: 'Active',
    });
    await makeAccounting(hit, { fiscalYear: 2026, bookedCost: 1000, accumulatedDepreciation: 600 });

    // ต่างกันทีละแกน — ทุกตัวต้องถูกคัดออก
    const wrongDep = await makeAsset({ assetNumber: 'X-001', locationId: loc, status: 'Active' });
    await makeAccounting(wrongDep, { fiscalYear: 2026, bookedCost: 1000, accumulatedDepreciation: 600 });

    const wrongStatus = await makeAsset({
      assetNumber: 'X-002',
      departmentId: dep,
      locationId: loc,
      status: 'Disposed',
    });
    await makeAccounting(wrongStatus, { fiscalYear: 2026, bookedCost: 1000, accumulatedDepreciation: 600 });

    const wrongYear = await makeAsset({
      assetNumber: 'X-003',
      departmentId: dep,
      locationId: loc,
      status: 'Active',
    });
    await makeAccounting(wrongYear, { fiscalYear: 2022, bookedCost: 1000, accumulatedDepreciation: 600 });

    const res = await assetService.findInventory({
      page: 1,
      limit: 20,
      departmentId: dep,
      locationId: loc,
      status: 'Active',
      fiscalYear: 2026,
      minNetBookValue: 300,
      maxNetBookValue: 500,
    });

    expect(res.total).toBe(1);
    expect(res.data[0]!.assetNumber).toBe('HIT-001');
  });
});

// ═══ ที่ตั้งแบบชี้บนผังได้ — หน้า Audit พึ่งสี่ฟิลด์นี้ทั้งหมด ═══
//
// subLocationName ที่มีอยู่เดิมเป็นข้อความไว้อ่าน ชี้บนแผนที่ไม่ได้ หน้า Audit ต้องการ id
// กับพิกัดจริง เทสต์ชุดนี้เฝ้าสองอย่าง: ฟิลด์มาครบ และตัวกรอง located ตัดถูกตัว
describe('findInventory — ที่ตั้งบนผัง', () => {
  /** ผูกห้อง (และหมุด) ให้ชิ้นที่สร้างไว้แล้ว — makeAsset ไม่รับสองอย่างนี้ */
  async function place(
    assetId: number,
    subLocationId: number,
    pin?: { posX: number; posY: number },
  ) {
    await db
      .update(asset)
      .set({ subLocationId, posX: pin?.posX ?? null, posY: pin?.posY ?? null })
      .where(eq(asset.id, assetId));
  }

  test('located=true เอาเฉพาะชิ้นที่ระบุห้องแล้ว และ total นับตามที่กรอง', async () => {
    const room = await makeSubLocation(locationId, { floor: '2', planKey: 'floor-2' });
    const pinned = await makeAsset({ assetNumber: 'LOC-001' });
    await place(pinned, room, { posX: 0.25, posY: 0.4 });
    const roomOnly = await makeAsset({ assetNumber: 'LOC-002' });
    await place(roomOnly, room);
    await makeAsset({ assetNumber: 'LOC-003' }); // ไม่ระบุห้อง

    const res = await assetService.findInventory({ page: 1, limit: 20, located: true });

    // ★ total ต้องเป็น 2 ไม่ใช่ 3 — คิวรีนับไม่ได้ join ตารางห้อง เงื่อนไขจึงต้องอยู่ที่
    //   asset.subLocationId เท่านั้น ถ้าเผลอไปเขียนที่คอลัมน์ของ asset_sub_location
    //   ตารางจะมา 2 แถวแต่เพจบอก 3 (บั๊กแบบเดียวกับที่ fiscalYear เคยเจอ)
    expect(res.total).toBe(2);
    expect(res.data.map((d) => d.assetNumber)).toEqual(['LOC-001', 'LOC-002']);
  });

  test('ไม่ส่ง located = เห็นครบเหมือนเดิม (หน้าทะเบียน/Dashboard ต้องไม่กระทบ)', async () => {
    const room = await makeSubLocation(locationId);
    const withRoom = await makeAsset({ assetNumber: 'ALL-001' });
    await place(withRoom, room);
    await makeAsset({ assetNumber: 'ALL-002' });

    const res = await assetService.findInventory({ page: 1, limit: 20 });

    expect(res.total).toBe(2);
  });

  test('คืน subLocationId / planKey / floor / หมุด ครบ และเป็น null ทั้งชุดเมื่อไม่ระบุห้อง', async () => {
    const room = await makeSubLocation(locationId, { floor: '2', room: 'ห้องบัญชี', planKey: 'floor-2' });
    const pinned = await makeAsset({ assetNumber: 'PIN-001' });
    await place(pinned, room, { posX: 0.25, posY: 0.4 });
    const roomOnly = await makeAsset({ assetNumber: 'PIN-002' });
    await place(roomOnly, room);
    await makeAsset({ assetNumber: 'PIN-003' });

    const res = await assetService.findInventory({ page: 1, limit: 20 });
    const byNumber = new Map(res.data.map((d) => [d.assetNumber, d]));

    expect(byNumber.get('PIN-001')).toMatchObject({
      subLocationId: room,
      planKey: 'floor-2',
      floor: '2',
      posX: 0.25,
      posY: 0.4,
    });

    // รู้ห้องแต่ยังไม่ปักหมุด — ยังพา auditor ไปถูกห้องได้ ต้องไม่ถูกกลบเป็น null ทั้งก้อน
    expect(byNumber.get('PIN-002')).toMatchObject({
      subLocationId: room,
      planKey: 'floor-2',
      posX: null,
      posY: null,
    });

    expect(byNumber.get('PIN-003')).toMatchObject({
      subLocationId: null,
      planKey: null,
      floor: null,
      posX: null,
      posY: null,
    });
  });
});

describe('สุ่มรายการตรวจ (random) — หน้า Audit', () => {
  /** สร้างของ 6 ชิ้น เลข A-001..A-006 ทั้งหมดลงทะเบียนแล้ว */
  async function seedSix() {
    for (const n of ['A-001', 'A-002', 'A-003', 'A-004', 'A-005', 'A-006']) {
      await makeAsset({ assetNumber: n });
    }
  }

  test('คืนตามจำนวน limit และทุกชิ้นมาจากกองที่มีจริง', async () => {
    await seedSix();

    const res = await list({ limit: 3, random: true });

    expect(res.data).toHaveLength(3);
    // total ยังเป็นยอดของ "ทั้งกองที่กรองแล้ว" ไม่ใช่จำนวนที่สุ่มออกมา — จอเอาไปขึ้นว่า
    // "สุ่มมา 3 จาก 6 ชิ้นที่ตรงเงื่อนไข"
    expect(res.total).toBe(6);
    for (const row of res.data) {
      expect(row.assetNumber).toMatch(/^A-00[1-6]$/);
    }
  });

  test('ไม่คืนชิ้นซ้ำในชุดเดียวกัน', async () => {
    await seedSix();

    const numbers = (await list({ limit: 6, random: true })).data.map((d) => d.assetNumber);

    expect(new Set(numbers).size).toBe(6);
  });

  test('ตัวกรองยังทำงาน — สุ่มจากผลที่กรองแล้ว ไม่ใช่จากทั้งทะเบียน', async () => {
    await seedSix();
    await makeAsset({ assetNumber: 'B-001', status: 'Lost' });
    await makeAsset({ assetNumber: 'B-002', status: 'Lost' });

    const res = await list({ limit: 20, random: true, status: 'Lost' });

    expect(res.total).toBe(2);
    expect(res.data.map((d) => d.assetNumber).sort()).toEqual(['B-001', 'B-002']);
  });

  test('ของที่ยังไม่ออกเลข/ถูกลบ ไม่ถูกสุ่มติดมา', async () => {
    await makeAsset({ assetNumber: 'A-001' });
    await makeAsset({ assetNumber: 'D-001', lifecycle: 'DRAFT' });
    await makeAsset({ assetNumber: 'X-001', deleted: true });

    const res = await list({ limit: 20, random: true });

    expect(res.data.map((d) => d.assetNumber)).toEqual(['A-001']);
  });

  test('page > 1 ไม่ตัดหัวชุดทิ้ง — offset ถูกบังคับเป็น 0', async () => {
    // ★ ถ้าไม่บังคับ offset หน้า 2 ของการสุ่มจะได้ผลว่างเมื่อของมีน้อยกว่า limit*2
    //   ซึ่งดูเหมือน "สุ่มแล้วไม่เจออะไรเลย" ทั้งที่มีของอยู่
    await seedSix();

    const res = await list({ page: 3, limit: 3, random: true });

    expect(res.data).toHaveLength(3);
  });

  test('ไม่ส่ง random = เรียงตามเลขเหมือนเดิม (หน้าทะเบียน/Dashboard ไม่กระทบ)', async () => {
    await seedSix();

    const res = await list({ limit: 6 });

    expect(res.data.map((d) => d.assetNumber)).toEqual([
      'A-001',
      'A-002',
      'A-003',
      'A-004',
      'A-005',
      'A-006',
    ]);
  });
});
