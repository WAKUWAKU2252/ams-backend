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
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '@intrastucture/db';
import { asset, assetAccounting } from '@intrastucture/db/schema';
import * as assetService from '@modules/business/asset/asset.service';
import { makeDepartment, makeEmployee, makeLocation, resetDb } from './helpers/factory';

let locationId = 0;

async function makeAsset(opts: {
  assetNumber: string;
  description?: string;
  serialNumber?: string | null;
  departmentId?: number | null;
  employeeId?: number | null;
  lifecycle?: 'DRAFT' | 'REGISTERED' | 'CANCELLED';
  deleted?: boolean;
}): Promise<number> {
  const [row] = await db
    .insert(asset)
    .values({
      origin: 'SAP_LEGACY',
      assetNumber: opts.assetNumber,
      description: opts.description ?? 'ของทดสอบ',
      serialNumber: opts.serialNumber ?? null,
      locationId,
      departmentId: opts.departmentId ?? null,
      employeeId: opts.employeeId ?? null,
      lifecycle: opts.lifecycle ?? 'REGISTERED',
      deletedAt: opts.deleted ? new Date().toISOString() : null,
    })
    .returning();
  return row!.id;
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
