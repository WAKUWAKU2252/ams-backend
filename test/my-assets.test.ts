// ═══ GET /assets/mine — สินทรัพย์ในความดูแลของฉัน (หน้า My asset) ═══
//
// สองเรื่องที่เทสต์นี้เฝ้าเป็นหลัก:
//
// 1. **ขอบเขต "ของฉัน"** — ต้องมาจาก token เท่านั้น ถ้าหลุดให้เห็นของคนอื่น มันคือการรั่ว
//    ข้อมูลว่าใครถือทรัพย์สินอะไรบ้าง ซึ่งเป็นข้อมูลบุคคล ไม่ใช่แค่ตัวเลขผิด
//
// 2. **0 กับ null ต้องไม่ปนกัน** — ที่ดินมีค่าเสื่อมสะสม 0 และอายุการใช้งาน 0 เดือนจริง ๆ
//    (วัดจาก LAN-200-12-001 มูลค่า 28.8 ล้าน) ถ้าโค้ดไหนเผลอใช้ `|| null` หรือ `?:` แบบ
//    falsy-check ที่ดินจะกลายเป็น "ไม่มีข้อมูล" ทั้งที่ตัวเลขถูกต้องสมบูรณ์
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { asset, assetAccounting, assetLocation, category } from '@intrastucture/db/schema';
import * as assetService from '@modules/business/asset/asset.service';
import { makeEmployee, makeLocation, makeUser, resetDb } from './helpers/factory';

/** สินทรัพย์เก่าจาก SAP — ใช้ในเทสต์นี้เพราะไม่ต้องมีโซ่ PO ครบชุดเหมือน PO_FLOW */
async function makeLegacyAsset(opts: {
  assetNumber: string;
  employeeId: number | null;
  locationId: number;
  description?: string;
  lifecycle?: 'DRAFT' | 'REGISTERED';
  categoryId?: number;
}): Promise<number> {
  const [row] = await db
    .insert(asset)
    .values({
      origin: 'SAP_LEGACY',
      assetNumber: opts.assetNumber,
      description: opts.description ?? 'ของทดสอบ',
      lifecycle: opts.lifecycle ?? 'REGISTERED',
      locationId: opts.locationId,
      employeeId: opts.employeeId,
      categoryId: opts.categoryId,
    })
    .returning();
  return row!.id;
}

async function makeAccounting(assetId: number, over: Record<string, unknown> = {}) {
  await db.insert(assetAccounting).values({
    assetId,
    fiscalYear: 2026,
    bookedCost: 12871.03,
    accumulatedDepreciation: 12870.03,
    salvageValue: 1,
    usefulLifeMonths: 60,
    remainingLifeMonths: 0,
    depreciationMethod: '01 Straight',
    depreciationStart: '2005-05-20',
    depreciationEnd: '2010-05-19',
    ...over,
  });
}

let locationId = 0;

beforeEach(async () => {
  await resetDb();
  locationId = await makeLocation();
});

describe('ขอบเขต "ของฉัน"', () => {
  test('เห็นเฉพาะของที่ผูกกับพนักงานของตัวเอง', async () => {
    const meEmp = await makeEmployee();
    const otherEmp = await makeEmployee();
    const meUser = await makeUser({ employeeId: meEmp });

    await makeLegacyAsset({ assetNumber: 'COM-100-05-001', employeeId: meEmp, locationId });
    await makeLegacyAsset({ assetNumber: 'COM-100-05-002', employeeId: otherEmp, locationId });
    await makeLegacyAsset({ assetNumber: 'COM-100-05-003', employeeId: null, locationId });

    const res = await assetService.findMine(meUser);

    expect(res.linkedToEmployee).toBe(true);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.assetNumber).toBe('COM-100-05-001');
  });

  test('บัญชีที่ยังไม่ผูกพนักงาน → linkedToEmployee: false ไม่ใช่แค่ items ว่าง', async () => {
    // สองสถานะนี้ต้องแยกกันให้ขาด — อันนี้ admin ต้องไปผูกให้ ไม่ใช่ผู้ใช้รอเฉย ๆ
    const userId = await makeUser();
    const someoneElse = await makeEmployee();
    await makeLegacyAsset({ assetNumber: 'COM-100-05-001', employeeId: someoneElse, locationId });

    const res = await assetService.findMine(userId);

    expect(res.linkedToEmployee).toBe(false);
    expect(res.items).toHaveLength(0);
  });

  test('ชิ้นที่ถูกลบและชิ้นที่ยังเป็นร่าง ไม่โผล่', async () => {
    const emp = await makeEmployee();
    const userId = await makeUser({ employeeId: emp });

    const deleted = await makeLegacyAsset({
      assetNumber: 'COM-100-05-001',
      employeeId: emp,
      locationId,
    });
    await db
      .update(asset)
      .set({ deletedAt: '2026-08-20T00:00:00.000Z' })
      .where(eq(asset.id, deleted));

    // ร่าง = ยังลงทะเบียนไม่เสร็จ ยังไม่มีเลข/QR — เอามาแสดงจะทำให้คนเข้าใจว่ารับผิดชอบแล้ว
    await makeLegacyAsset({
      assetNumber: 'COM-100-05-002',
      employeeId: emp,
      locationId,
      lifecycle: 'DRAFT',
    });
    await makeLegacyAsset({ assetNumber: 'COM-100-05-003', employeeId: emp, locationId });

    const res = await assetService.findMine(userId);

    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.assetNumber).toBe('COM-100-05-003');
  });
});

describe('ตัวเลขบัญชี', () => {
  test('netBookValue คำนวณที่ backend ไม่ปล่อยให้หน้าจอลบเอง', async () => {
    const emp = await makeEmployee();
    const userId = await makeUser({ employeeId: emp });
    const id = await makeLegacyAsset({
      assetNumber: 'COM-100-05-001',
      employeeId: emp,
      locationId,
    });
    // ตัวเลขจริงจากหน้าจอ SAP: 90,000 − 11,779.715768 = 78,220.284232
    await makeAccounting(id, { bookedCost: 90000, accumulatedDepreciation: 11779.715768 });

    const [item] = (await assetService.findMine(userId)).items;

    expect(item!.accounting!.netBookValue).toBeCloseTo(78220.284232, 6);
    expect(item!.accounting!.fiscalYear).toBe(2026);
  });

  test('ที่ดิน: ค่าเสื่อม 0 และอายุ 0 เดือน ต้องไม่กลายเป็น null', async () => {
    const emp = await makeEmployee();
    const userId = await makeUser({ employeeId: emp });
    const id = await makeLegacyAsset({
      assetNumber: 'LAN-200-12-001',
      employeeId: emp,
      locationId,
      description: 'ที่ดิน โฉนด 42003',
    });
    await makeAccounting(id, {
      bookedCost: 28836500,
      accumulatedDepreciation: 0,
      usefulLifeMonths: 0,
      remainingLifeMonths: 0,
    });

    const acct = (await assetService.findMine(userId)).items[0]!.accounting!;

    expect(acct.accumulatedDepreciation).toBe(0);
    expect(acct.usefulLifeMonths).toBe(0);
    // ไม่คิดค่าเสื่อม → มูลค่าคงเหลือเท่าราคาทุนเป๊ะ
    expect(acct.netBookValue).toBe(28836500);
  });

  test('ชิ้นที่ยังไม่มีข้อมูลบัญชี → accounting เป็น null ทั้งก้อน', async () => {
    // ไม่ใช่ object ที่ทุกช่องเป็น null — หน้าจอเช็คก้อนเดียวจบ ไม่ต้องไล่ทีละช่อง
    const emp = await makeEmployee();
    const userId = await makeUser({ employeeId: emp });
    await makeLegacyAsset({ assetNumber: 'COM-100-05-001', employeeId: emp, locationId });

    const [item] = (await assetService.findMine(userId)).items;

    expect(item!.accounting).toBeNull();
    // แต่ตัวชิ้นยังต้องอยู่ในลิสต์ ไม่ถูกกรองทิ้งเพราะไม่มียอด
    expect(item!.assetNumber).toBe('COM-100-05-001');
  });

  test('ยอดขาดตัวตั้งหรือตัวลบ → netBookValue เป็น null ไม่ใช่เดาเป็น 0', async () => {
    // เกิดกับชิ้นที่มีรายการปรับปรุงที่ระบบยังไม่รองรับ (connector เก็บค่าเสื่อมเป็น NULL)
    const emp = await makeEmployee();
    const userId = await makeUser({ employeeId: emp });
    const id = await makeLegacyAsset({
      assetNumber: 'COM-100-05-001',
      employeeId: emp,
      locationId,
    });
    await makeAccounting(id, { accumulatedDepreciation: null });

    const acct = (await assetService.findMine(userId)).items[0]!.accounting!;

    expect(acct.accumulatedDepreciation).toBeNull();
    expect(acct.netBookValue).toBeNull();
  });
});

describe('ข้อมูลประกอบ', () => {
  test('ชื่อหมวดและที่ตั้งมาพร้อมกัน ไม่ต้องให้หน้าจอยิงถามซ้ำ', async () => {
    const emp = await makeEmployee();
    const userId = await makeUser({ employeeId: emp });
    const [cat] = await db
      .insert(category)
      .values({ code: '1216401', name: 'เครื่องใช้สำนักงาน' })
      .returning();
    const [loc] = await db.select().from(assetLocation).where(eq(assetLocation.id, locationId));

    await makeLegacyAsset({
      assetNumber: 'COM-100-05-001',
      employeeId: emp,
      locationId,
      categoryId: cat!.id,
    });

    const [item] = (await assetService.findMine(userId)).items;

    expect(item!.categoryName).toBe('เครื่องใช้สำนักงาน');
    expect(item!.locationName).toBe(loc!.name);
    // ไม่มีตำแหน่งย่อย = null ไม่ใช่สตริงว่าง (หน้าจอแสดง '—')
    expect(item!.subLocationName).toBeNull();
  });
});

describe('QR บนหน้ารายละเอียด', () => {
  test('ส่ง qrCode ที่เก็บไว้มาด้วย — หน้าจอต้องวาดจากค่านี้ ไม่ประกอบเอง', async () => {
    // ถ้าหน้าจอประกอบ URL เองจาก assetNumber วันที่ APP_BASE_URL เปลี่ยน จอจะโชว์ QR
    // ที่พาไปคนละที่กับสติกเกอร์ที่แปะอยู่บนเครื่องจริง โดยไม่มีอะไรฟ้อง
    const emp = await makeEmployee();
    const userId = await makeUser({ employeeId: emp });
    const id = await makeLegacyAsset({
      assetNumber: 'COM-100-05-001',
      employeeId: emp,
      locationId,
    });
    await db
      .update(asset)
      .set({ qrCode: 'https://ams.example.com/assets/COM-100-05-001' })
      .where(eq(asset.id, id));

    const [item] = (await assetService.findMine(userId)).items;

    expect(item!.qrCode).toBe('https://ams.example.com/assets/COM-100-05-001');
  });

  test('ชิ้นที่ยังไม่มี QR → null (หน้าจอซ่อนบล็อกนั้นไป)', async () => {
    const emp = await makeEmployee();
    const userId = await makeUser({ employeeId: emp });
    await makeLegacyAsset({ assetNumber: 'COM-100-05-002', employeeId: emp, locationId });

    expect((await assetService.findMine(userId)).items[0]!.qrCode).toBeNull();
  });
});
