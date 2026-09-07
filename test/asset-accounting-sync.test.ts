// ═══ มูลค่าทางบัญชี/ค่าเสื่อมจาก SAP (เฟส 3) ═══
//
// ตัวเลขในเทสต์นี้ไม่ได้แต่งขึ้น — คัดมาจาก COM-100-05-002 ของจริงที่สำรวจไว้:
// APC 12,871.03 / SalvageVal 1.00 / UsefulLife 60 เดือน / ค่าเสื่อมสะสมตันที่ 12,870.03
// (= APC − SalvageVal ตามธรรมเนียมมูลค่าซาก 1 บาท)
//
// ★ ค่าบัญชีเดินทางมาในแถวเดียวกับข้อมูลสินทรัพย์ (คิวรีเดียว join ITM8/ITM7 มาด้วย)
//   แล้ว connector แยกลงสองตาราง — แพทเทิร์นเดียวกับ PO ที่แยก header/line
//   fixture ที่นี่จึงประกอบเป็น sapAsset(acct()) ไม่ใช่สองอาร์เรย์แยกกัน
//
// สามเรื่องที่เทสต์นี้เฝ้า เพราะพังแล้วจะไปโผล่เป็นตัวเลขผิดบนรายงานบัญชีโดยไม่มีอะไรฟ้อง:
//   1. 0 ต้องเป็น 0 ไม่ใช่ NULL (ของที่ยังไม่เริ่มคิดค่าเสื่อม)
//   2. รายการปรับปรุงที่ยังไม่รองรับ ต้องทำให้ค่าเสื่อมสะสมเป็น NULL ไม่ใช่เก็บเลขที่รู้ว่าต่ำกว่าจริง
//   3. ต้องเขียนได้ตั้งแต่รอบแรกที่สินทรัพย์เข้าระบบ (FK ต้องการให้ asset มาก่อนในทรานแซกชันเดียวกัน)
import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { asset, assetAccounting, assetLocation, category } from '@intrastucture/db/schema';
import type { Tx } from '@modules/integrate/SAP/sync.types';
import { resetDb, TEST_COMPANY } from './helpers/factory';

// ประตู SAP ปิดอยู่แล้วจาก test/setup.ts (preload) — เหตุผลเต็มอยู่ที่นั่น

// connector เป็น factory ตั้งแต่ 0021 — ผูกกับบริษัทก่อนใช้
const { makeAssetConnector } = await import('@modules/integrate/SAP/connectors/asset.connector');
const assetConnector = makeAssetConnector(TEST_COMPANY, '117');
type LegacyAssetPull = Parameters<typeof assetConnector.apply>[1];
type LegacyAssetRow = LegacyAssetPull['assets'][number];

const ACCOUNTING_KEYS = [
  'fiscalYear',
  'bookedCost',
  'bookedCostHistorical',
  'accumulatedDepreciation',
  'salvageValue',
  'unplannedDep',
  'specialDep1',
  'specialDep2',
  'specialDep3',
  'writeUp',
  'appreciation',
  'usefulLifeMonths',
  'remainingLifeMonths',
  'depreciationMethod',
  'depreciationStart',
  'depreciationEnd',
] as const;
type AccountingFields = Pick<LegacyAssetRow, (typeof ACCOUNTING_KEYS)[number]>;

const ASSET_NO = 'COM-100-05-002';
const tx = db as unknown as Tx;

/** LEFT JOIN ITM8 ไม่เจอคู่ = ทุกช่องเป็น null พร้อมกัน (ชิ้นที่ SAP ยังไม่มียอดบัญชีให้) */
const NO_ACCOUNTING = Object.fromEntries(
  ACCOUNTING_KEYS.map((k) => [k, null]),
) as AccountingFields;

const sapAsset = (over: Partial<LegacyAssetRow> = {}): LegacyAssetRow => ({
  assetNumber: ASSET_NO,
  description: 'ของเก่าจาก SAP',
  isActive: 'Y',
  createDate: new Date('2005-05-20'),
  updateDate: new Date('2026-08-20'),
  assetClass: '1216401-0-775',
  uom: 'EA',
  serialNumber: null,
  locationCode: null,
  employeeCode: null,
  acqDate: null,
  vendor: null,
  invoiceNo: null,
  // มาคนละ join กับชุด ITM8 ข้างล่าง (ACQ1) จึงไม่ได้อยู่ใน NO_ACCOUNTING — ค่าเริ่มต้น
  // คือ "ไม่มีรายการซื้อใน ACQ1" เทสต์ที่ต้องการทดสอบทางถอยกลับต้องส่งค่ามาเอง
  acquisitionPostedTotal: null,
  ...NO_ACCOUNTING,
  ...over,
});

/** ชุดบัญชีของ COM-100-05-002 ปี 2010 (ปีที่ค่าเสื่อมตัน) — เอาไปประกอบกับ sapAsset() */
const acct = (over: Partial<AccountingFields> = {}): AccountingFields => ({
  fiscalYear: '2010',
  bookedCost: 12871.03,
  bookedCostHistorical: 12871.03,
  accumulatedDepreciation: 12870.03,
  salvageValue: 1,
  unplannedDep: 0,
  specialDep1: 0,
  specialDep2: 0,
  specialDep3: 0,
  writeUp: 0,
  appreciation: 0,
  usefulLifeMonths: 60,
  remainingLifeMonths: 0,
  depreciationMethod: '01 Straight',
  depreciationStart: new Date('2005-05-20'),
  depreciationEnd: new Date('2010-05-19'),
  ...over,
});

const pull = (assets: LegacyAssetRow[]): LegacyAssetPull => ({ assets, purchasing: [] });

async function seed() {
  await db.insert(assetLocation).values({ code: 'UNASSIGNED', name: 'ยังไม่ระบุที่ตั้ง' });
  await db.insert(category).values({ code: '1216401', name: 'เครื่องใช้สำนักงาน' });
}

const readAcct = async () => {
  const [row] = await db
    .select()
    .from(assetAccounting)
    .innerJoin(asset, eq(asset.id, assetAccounting.assetId))
    .where(eq(asset.assetNumber, ASSET_NO));
  return row?.asset_accounting;
};

beforeEach(async () => {
  await resetDb();
  await seed();
});

describe('เขียนมูลค่าทางบัญชี', () => {
  test('สินทรัพย์ที่เพิ่งถูกสร้างในรอบเดียวกัน ต้องได้มูลค่าเลย (ลำดับ FK ถูก)', async () => {
    await assetConnector.apply(tx, pull([sapAsset(acct())]));

    const row = await readAcct();
    expect(row).toBeDefined();
    expect(row!.fiscalYear).toBe(2010);
    expect(row!.bookedCost).toBe(12871.03);
    expect(row!.accumulatedDepreciation).toBe(12870.03);
    expect(row!.salvageValue).toBe(1);
    expect(row!.usefulLifeMonths).toBe(60);
    expect(row!.depreciationMethod).toBe('01 Straight');
    expect(row!.depreciationStart).toBe('2005-05-20');
    expect(row!.depreciationEnd).toBe('2010-05-19');
  });

  test('ค่าบัญชีซ้ำมาหลายแถว (สินทรัพย์อยู่บนหลายใบกำกับ) ต้องได้แถวเดียว', async () => {
    // ของเหมา/งานโครงการอยู่บนใบกำกับหลายใบ คิวรีจึงคืนหลายแถวต่อหนึ่งสินทรัพย์
    // โดยค่าบัญชีซ้ำเหมือนกันทุกแถว — collapse() ต้องยุบให้เหลือชุดเดียว ไม่ใช่เขียนซ้ำ
    const a = acct();
    await assetConnector.apply(
      tx,
      pull([
        sapAsset({ ...a, invoiceNo: 1, acqDate: new Date('2005-06-01') }),
        sapAsset({ ...a, invoiceNo: 2, acqDate: new Date('2005-07-01') }),
      ]),
    );

    expect(await db.$count(assetAccounting)).toBe(1);
    expect((await readAcct())!.bookedCost).toBe(12871.03);
  });

  test('NBV คำนวณจากสองช่องนี้ได้ตรงกับที่ SAP แสดง', async () => {
    // ไม่ได้เก็บ netBookValue ไว้ — เทสต์นี้ยืนยันว่าที่เก็บไว้พอให้หน้าจอลบเองได้จริง
    await assetConnector.apply(
      tx,
      pull([sapAsset(acct({ bookedCost: 90000, accumulatedDepreciation: 11779.715768 }))]),
    );

    const row = await readAcct();
    expect(row!.bookedCost! - row!.accumulatedDepreciation!).toBeCloseTo(78220.284232, 6);
  });

  test('ค่าเสื่อมสะสม 0 ต้องเก็บเป็น 0 ไม่ใช่ NULL', async () => {
    // ของที่ยังไม่เริ่มคิดค่าเสื่อม — วัดจริงแล้วต่ำสุดใน ITM8 คือ 0.000000 ไม่ใช่ค่าว่าง
    // ถ้าเผลอแปลงเป็น NULL จะแยกไม่ออกจาก "ยังไม่ได้ sync"
    await assetConnector.apply(tx, pull([sapAsset(acct({ accumulatedDepreciation: 0 }))]));

    expect((await readAcct())!.accumulatedDepreciation).toBe(0);
  });

  test('ITM7 ไม่มีคู่ → พารามิเตอร์ค่าเสื่อมเป็น NULL แต่ยอดยังเข้า', async () => {
    await assetConnector.apply(
      tx,
      pull([
        sapAsset(
          acct({
            usefulLifeMonths: null,
            remainingLifeMonths: null,
            depreciationMethod: null,
            depreciationStart: null,
            depreciationEnd: null,
          }),
        ),
      ]),
    );

    const row = await readAcct();
    expect(row!.bookedCost).toBe(12871.03);
    expect(row!.usefulLifeMonths).toBeNull();
    expect(row!.depreciationMethod).toBeNull();
  });

  test('รอบถัดไปทับค่าเดิมทั้งแถว ไม่ใช่ COALESCE', async () => {
    await assetConnector.apply(tx, pull([sapAsset(acct())]));
    // ปีถัดมา SAP ไม่มีพารามิเตอร์ให้แล้ว — ของเดิมต้องถูกล้าง ไม่ใช่ค้างไว้
    await assetConnector.apply(
      tx,
      pull([sapAsset(acct({ fiscalYear: '2011', depreciationMethod: null }))]),
    );

    const row = await readAcct();
    expect(row!.fiscalYear).toBe(2011);
    expect(row!.depreciationMethod).toBeNull();
    expect(await db.$count(assetAccounting)).toBe(1); // upsert ไม่ใช่ insert ซ้ำ
  });

  test('สินทรัพย์ที่ SAP ยังไม่มียอดบัญชีให้ → ไม่มีแถวใน asset_accounting', async () => {
    // "ไม่มีแถว = ยังไม่เคย sync ข้อมูลบัญชี" คือกติกาที่ทำให้ไม่ต้องมีคอลัมน์ธงบน asset
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    await assetConnector.apply(tx, pull([sapAsset()]));
    errors.mockRestore();

    expect(await db.$count(asset)).toBe(1);
    expect(await db.$count(assetAccounting)).toBe(0);
  });
});

describe('APC เป็น 0 ในปีที่ซื้อ → ถอยไปใช้ยอดรวมรายการซื้อจาก ACQ1', () => {
  // ITM8.APC คือ "ยอดยกมาต้นปีบัญชี" ไม่ใช่ยอดปลายปี ปีที่ซื้อจึงเป็น 0 เสมอเพราะตอนต้นปี
  // ของยังไม่เข้ามา — ของที่เพิ่งซื้อในปีบัญชีปัจจุบันมีแถว ITM8 อยู่แถวเดียวคือแถวนั้นพอดี
  // (วัด 2026-08-24: 101 จาก 2,726 ชิ้น ทั้งหมดมีแถวเดียวจริง ไม่มีเคสตัดจำหน่ายปนมา
  //  และ 100 ชิ้นในนั้นมียอดจริงใน ACQ1) ถ้าไม่ถอยไปเอา ของใหม่ทุกชิ้นจะเข้าระบบด้วย
  // มูลค่า 0 โดยรอบ sync ยังขึ้น SUCCESS ตามปกติ ไม่มีอะไรฟ้อง

  test('APC = 0 แต่ ACQ1 มียอด → ใช้ยอดจาก ACQ1', async () => {
    await assetConnector.apply(
      tx,
      pull([sapAsset({ ...acct({ bookedCost: 0 }), acquisitionPostedTotal: 12871.03 })]),
    );

    expect((await readAcct())!.bookedCost).toBe(12871.03);
  });

  test('APC เป็น NULL แต่ ACQ1 มียอด → ใช้ยอดจาก ACQ1', async () => {
    await assetConnector.apply(
      tx,
      pull([sapAsset({ ...acct({ bookedCost: null }), acquisitionPostedTotal: 12871.03 })]),
    );

    expect((await readAcct())!.bookedCost).toBe(12871.03);
  });

  test('APC มีค่าอยู่แล้ว → ACQ1 ห้ามทับ', async () => {
    // ★ กติกาที่สำคัญที่สุดของทั้งบล็อกนี้: ACQ1 = ยอดรวม "รายการซื้อทั้งหมดที่เคยเกิด"
    // ส่วน APC = ยอดคงเหลือที่ผ่านการตัดจำหน่าย/ปรับปรุงมาแล้ว ปล่อยให้ทับเมื่อไหร่
    // = ฟื้นมูลค่าของที่ตัดจำหน่ายไปแล้วกลับมาเต็มจำนวน โดยไม่มีอะไรฟ้อง
    await assetConnector.apply(
      tx,
      pull([sapAsset({ ...acct({ bookedCost: 500 }), acquisitionPostedTotal: 12871.03 })]),
    );

    expect((await readAcct())!.bookedCost).toBe(500);
  });

  test('ไม่มียอดทั้งสองฝั่ง → คงค่าเดิมของ ITM8 ไม่แต่งให้ดูดีกว่าความจริง', async () => {
    // มีอยู่ 1 ชิ้นที่เป็นแบบนี้จริง = ไม่เคยมีรายการซื้อ ต้องเห็นเป็น 0 ตามตรง
    await assetConnector.apply(tx, pull([sapAsset(acct({ bookedCost: 0 }))]));

    expect((await readAcct())!.bookedCost).toBe(0);
  });

  test('ไม่มีแถว ITM8 เลย → ยังไม่เขียนแถวบัญชี แม้ ACQ1 จะมียอด', async () => {
    // ACQ1 เป็นทางถอยของ "ยอดในแถวที่มีอยู่" ไม่ใช่ตัวสร้างแถวบัญชีขึ้นมาเอง —
    // fiscalYear เป็น NOT NULL และ ACQ1 ไม่ได้บอกปีบัญชี จึงไม่มีอะไรให้เขียนลงไป
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    await assetConnector.apply(tx, pull([sapAsset({ acquisitionPostedTotal: 12871.03 })]));
    errors.mockRestore();

    expect(await db.$count(asset)).toBe(1);
    expect(await db.$count(assetAccounting)).toBe(0);
  });
});

describe('ด่านกันล้มเงียบ (ฝั่งบัญชีหายทั้งยวง)', () => {
  // LEFT JOIN ทำให้ ITM8 พังแบบไม่มี error ได้ — รอบ sync จะขึ้น SUCCESS ทั้งที่มูลค่า
  // ไม่ได้อัปเดตเลย ด่านนี้คือสิ่งเดียวที่จะบอกว่าเกิดขึ้น
  test('ไม่มีชิ้นไหนมีข้อมูลบัญชีเลย → ต้องดังออกมา ไม่ใช่เงียบ', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});

    await assetConnector.apply(tx, pull([sapAsset(), sapAsset({ assetNumber: 'COM-100-05-003' })]));

    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls[0]![0]).toContain('ไม่มีข้อมูลบัญชีติดมาเลย');
    errors.mockRestore();

    // แต่ทะเบียนสินทรัพย์ต้องเข้าครบตามปกติ ไม่ถูก rollback ทิ้งเพราะเรื่องฝั่งบัญชี
    expect(await db.$count(asset)).toBe(2);
  });

  test('มีบางชิ้นที่มีข้อมูลบัญชี → ไม่ต้องดัง (สภาพปกติ)', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});

    await assetConnector.apply(
      tx,
      pull([sapAsset(acct()), sapAsset({ assetNumber: 'COM-100-05-003' })]),
    );

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
    expect(await db.$count(assetAccounting)).toBe(1);
  });

  test('ค่าเดิมไม่ถูกล้างทิ้งตอนฝั่งบัญชีหาย', async () => {
    await assetConnector.apply(tx, pull([sapAsset(acct())]));
    const before = (await readAcct())!;

    const errors = spyOn(console, 'error').mockImplementation(() => {});
    await assetConnector.apply(tx, pull([sapAsset()]));
    errors.mockRestore();

    // ค้างเก่าดีกว่าหาย — อายุของมันอ่านได้จาก syncedAt ที่ไม่ขยับ
    const after = (await readAcct())!;
    expect(after.bookedCost).toBe(before.bookedCost);
    expect(after.syncedAt).toBe(before.syncedAt);
  });
});

describe('ด่านตรวจรายการปรับปรุงที่ยังไม่รองรับ', () => {
  test.each([
    ['unplannedDep', 'ตัดด้อยค่า'],
    ['specialDep1', 'ค่าเสื่อมพิเศษ'],
    ['writeUp', 'ตีราคาเพิ่ม'],
    ['appreciation', 'ส่วนเกินทุนจากการตีราคา'],
  ])('%s ไม่เป็น 0 (%s) → ค่าเสื่อมสะสมต้องเป็น NULL', async (field) => {
    await assetConnector.apply(
      tx,
      pull([sapAsset(acct({ [field]: 5000 } as Partial<AccountingFields>))]),
    );

    const row = await readAcct();
    // ยอดที่เก็บได้จะต่ำกว่าความจริงเพราะไม่มีคอลัมน์รองรับส่วนปรับปรุง — เก็บ NULL
    // ("ยังไม่รู้") ตรงกว่าเก็บตัวเลขที่รู้อยู่แล้วว่าผิด แล้วปล่อยให้ไหลไปขึ้นรายงาน
    expect(row!.accumulatedDepreciation).toBeNull();
    // ช่องอื่นยังเก็บตามปกติ ไม่ได้ทิ้งทั้งแถว
    expect(row!.bookedCost).toBe(12871.03);
  });

  test('ทุกช่องเป็น 0 → เก็บค่าเสื่อมสะสมตามปกติ', async () => {
    await assetConnector.apply(tx, pull([sapAsset(acct())]));
    expect((await readAcct())!.accumulatedDepreciation).toBe(12870.03);
  });
});

describe('ของที่จับคู่ไม่ได้', () => {
  test('สินทรัพย์ถูกลบไปแล้ว → ไม่เขียนมูลค่าให้ (เคารพการลบ)', async () => {
    await assetConnector.apply(tx, pull([sapAsset()]));
    await db.update(asset).set({ deletedAt: '2026-08-10T00:00:00.000Z' });

    await assetConnector.apply(tx, pull([sapAsset(acct())]));

    expect(await db.$count(assetAccounting)).toBe(0);
  });

  test('fiscalYear อ่านเป็นปีไม่ได้ → ข้ามแถวนั้น (คอลัมน์เป็น NOT NULL)', async () => {
    // '' และ null ผ่าน Number.isInteger ได้เพราะ Number() คืน 0 — ต้องกันด้วย regex
    await assetConnector.apply(tx, pull([sapAsset(acct({ fiscalYear: '' }))]));
    expect(await db.$count(assetAccounting)).toBe(0);
  });
});
