// ═══ GET /assets/by-number — ปลายทางของ QR บนสติกเกอร์ ═══
//
// เส้นนี้คือสิ่งเดียวที่ทำให้สติกเกอร์ 2,721 ใบมีประโยชน์ ถ้ามันพังกับเลขบางรูปแบบ
// สติกเกอร์ของชิ้นนั้นจะกลายเป็นกระดาษเปล่าโดยไม่มีใครรู้จนกว่าจะมีคนเดินไปสแกนจริง
//
// เคสที่เฝ้าเป็นพิเศษ: **เลขที่มี '/' อยู่ข้างใน** (MAC-212-13-001/1, MAC-1-21/12-002)
// เป็นของจริงในทะเบียน 3 ชิ้น และเป็นเหตุผลที่ endpoint นี้รับเลขทาง query ไม่ใช่ path
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { asset, assetAccounting, assetSubLocation, category } from '@intrastucture/db/schema';
import * as assetService from '@modules/business/asset/asset.service';
import { makeDepartment, makeEmployee, makeLocation, resetDb } from './helpers/factory';

let locationId = 0;

async function makeLegacyAsset(opts: {
  assetNumber: string;
  description?: string;
  employeeId?: number;
  departmentId?: number;
  subLocationId?: number;
  categoryId?: number;
}): Promise<number> {
  const [row] = await db
    .insert(asset)
    .values({
      origin: 'SAP_LEGACY',
      assetNumber: opts.assetNumber,
      description: opts.description ?? 'ของทดสอบ',
      lifecycle: 'REGISTERED',
      locationId,
      employeeId: opts.employeeId,
      departmentId: opts.departmentId,
      subLocationId: opts.subLocationId,
      categoryId: opts.categoryId,
      serialNumber: 'SN-001',
      uom: 'EA',
      assetClass: '1216401-0-775',
    })
    .returning();
  return row!.id;
}

beforeEach(async () => {
  await resetDb();
  locationId = await makeLocation();
});

describe('ค้นด้วยเลขสินทรัพย์', () => {
  test('เลขปกติ — คืนข้อมูลครบพร้อมมูลค่าบัญชี', async () => {
    const id = await makeLegacyAsset({ assetNumber: 'COM-100-05-002', description: 'DELL 780' });
    await db.insert(assetAccounting).values({
      assetId: id,
      fiscalYear: 2026,
      bookedCost: 2500,
      accumulatedDepreciation: 1541.35,
      salvageValue: 1,
      usefulLifeMonths: 36,
    });

    const res = await assetService.findByAssetNumber('COM-100-05-002');

    expect(res.id).toBe(id);
    expect(res.description).toBe('DELL 780');
    expect(res.accounting!.netBookValue).toBeCloseTo(958.65, 2);
    expect(res.accounting!.fiscalYear).toBe(2026);
  });

  test.each([
    ['MAC-212-13-001/1', 'ถัง Silo'],
    ['MAC-1-21/12-002', 'เครื่องบรรจุ'],
    ['Vortex Ring Blower ยี่ห้อ Hitachi รุ่น VB-004-DN', 'โบลเวอร์'],
  ])('เลขที่มีอักขระพิเศษ: %s', async (assetNumber, description) => {
    // ทั้งสามเป็นของจริงในทะเบียน — ถ้าเส้นนี้รับเป็น path parameter เคสที่มี '/'
    // จะแตกเป็นสอง segment แล้ว 404 ทั้งที่ของมีอยู่
    const id = await makeLegacyAsset({ assetNumber, description });

    const res = await assetService.findByAssetNumber(assetNumber);

    expect(res.id).toBe(id);
    expect(res.assetNumber).toBe(assetNumber);
  });

  test('ตัดช่องว่างหัวท้ายก่อนค้น', async () => {
    // เลขที่ถูก copy มาจาก Excel/อีเมลติดช่องว่างมาด้วยเป็นเรื่องปกติ
    await makeLegacyAsset({ assetNumber: 'COM-100-05-002' });

    const res = await assetService.findByAssetNumber('  COM-100-05-002  ');

    expect(res.assetNumber).toBe('COM-100-05-002');
  });
});

describe('ข้อมูลประกอบที่คนหน้างานต้องใช้', () => {
  test('ที่ตั้ง ตำแหน่งย่อย ผู้ดูแล แผนก หมวด มาครบในรอบเดียว', async () => {
    const departmentId = await makeDepartment('แผนกบัญชี');
    const employeeId = await makeEmployee({ departmentId });
    const [sub] = await db
      .insert(assetSubLocation)
      .values({ code: 'HQ-F2-201', locationId, floor: '2', room: '201' })
      .returning();
    const [cat] = await db
      .insert(category)
      .values({ code: '1216401', name: 'เครื่องใช้สำนักงาน' })
      .returning();

    await makeLegacyAsset({
      assetNumber: 'COM-100-05-002',
      employeeId,
      departmentId,
      subLocationId: sub!.id,
      categoryId: cat!.id,
    });

    const res = await assetService.findByAssetNumber('COM-100-05-002');

    expect(res.subLocationName).toBe('ชั้น 2 / ห้อง 201');
    expect(res.departmentName).toBe('แผนกบัญชี');
    expect(res.categoryName).toBe('เครื่องใช้สำนักงาน');
    expect(res.holderName).not.toBeNull();
  });

  test('ไม่มีผู้ดูแล → null ไม่ใช่ error (ของเก่าส่วนใหญ่เป็นแบบนี้)', async () => {
    await makeLegacyAsset({ assetNumber: 'COM-100-05-002' });

    const res = await assetService.findByAssetNumber('COM-100-05-002');

    expect(res.holderName).toBeNull();
    expect(res.departmentName).toBeNull();
    expect(res.accounting).toBeNull();
  });
});

describe('เคสที่ต้องปฏิเสธ', () => {
  test('เลขที่ไม่มีในระบบ → 404 พร้อมเลขที่สแกนมา', async () => {
    // ข้อความต้องมีเลขอยู่ด้วย คนหน้างานจะได้รายงานต่อได้ว่าสติกเกอร์ใบไหนมีปัญหา
    await expect(assetService.findByAssetNumber('COM-999-99-999')).rejects.toThrow(
      /COM-999-99-999/,
    );
  });

  test('ชิ้นที่ถูกลบไปแล้ว → หาไม่เจอ', async () => {
    const id = await makeLegacyAsset({ assetNumber: 'COM-100-05-002' });
    await db
      .update(asset)
      .set({ deletedAt: '2026-08-20T00:00:00.000Z' })
      .where(eq(asset.id, id));

    await expect(assetService.findByAssetNumber('COM-100-05-002')).rejects.toThrow();
  });

  test('ส่งช่องว่างล้วนมา → บอกว่าต้องระบุเลข', async () => {
    await expect(assetService.findByAssetNumber('   ')).rejects.toThrow(/ระบุเลขสินทรัพย์/);
  });
});
