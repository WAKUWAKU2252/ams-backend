// ═══ เส้นแบ่งความเป็นเจ้าของข้อมูลบนแถว PO_FLOW ═══
//
// connector ตัวนี้มีสี่สายเขียนที่กติกาไม่เหมือนกันเลย และทั้งสี่ชี้ไปที่ตาราง asset เดียวกัน
// ไฟล์นี้เฝ้าเส้นแบ่งระหว่างสายพวกนั้น เพราะเป็นจุดที่พังแล้วไม่มี error ให้เห็นสักตัว:
//
//   1-2) SAP_LEGACY  — SAP เป็นเจ้าของทั้งแถว (insert/update, ทดสอบที่อื่น)
//   3)   PO_FLOW + เลขสินทรัพย์ — SAP เป็นเจ้าของ 3 ช่อง (assetClass/categoryId/uom)
//   4)   PO_FLOW ที่ยังไม่มีเลข  — เติม 3 ช่องเดิมจาก "รหัสจัดซื้อ" บนบรรทัด PO แต่หยาบกว่า
//        จึงเติมเฉพาะช่องที่ยังว่าง ห้ามทับของที่มาจากเลขสินทรัพย์
//
// ถ้าใครเผลอปลดล็อกคอลัมน์เพิ่ม งานที่คนกรอกเอง (ที่ตั้ง/ผู้ถือครอง/แผนก) จะถูกดึงกลับเป็น
// ค่าของ SAP ทุกนาทีที่ scheduler เดิน โดยไม่มีอะไรฟ้อง
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import {
  asset,
  assetLocation,
  category,
  department,
  employee,
  purchaseOrderItem,
  sapAssetUnknownNumber,
} from '@intrastucture/db/schema';
import type { Tx } from '@modules/integrate/SAP/sync.types';
import { makeEmployee, makePo, makeGrpo, makeRequest, makeUser, resetDb } from './helpers/factory';
import { assetQrUrl } from '@common/app-url';

// ── ปิดประตู SAP ก่อน import connector
//
// apply() ที่เทสต์นี้เรียกไม่แตะ SAP อยู่แล้ว (pool เป็น lazy และ sapQuery ถูกเรียกจาก
// fetch() เท่านั้น) แต่ถ้าวันหลังมีใครเผลอเรียกเพิ่มเข้ามา ต้องระเบิดตรงนี้ ไม่ใช่ไปโผล่
// เป็นคิวรีบน SBO_PRD_UBA ซึ่งเป็น ERP จริงที่คนทั้งบริษัทใช้อยู่
//
// ด่านตัด fetch ใน test/setup.ts ครอบตัวนี้ไม่ได้ — mssql คุยผ่าน TCP ไม่ใช่ HTTP
// คงของจริงไว้ทุกตัวยกเว้น sapQuery เพราะ connector ตัวอื่นใช้ asDateTime จากไฟล์เดียวกัน
const realSapClient = await import('@intrastucture/sap/client');
mock.module('@intrastucture/sap/client', () => ({
  ...realSapClient,
  sapQuery: async () => {
    throw new Error('เทสต์พยายามคิวรี SAP จริง — apply() ไม่ควรแตะ SAP เลย');
  },
}));

const { assetConnector } = await import('@modules/integrate/SAP/connectors/asset.connector');
type LegacyAssetPull = Parameters<typeof assetConnector.apply>[1];
type LegacyAssetRow = LegacyAssetPull['assets'][number];
type PurchasingItemRow = LegacyAssetPull['purchasing'][number];

/** แถวพักที่ apply() บังคับให้มี (migration 0010 สร้างให้ แต่ resetDb ล้างทิ้งทุกครั้ง) */
const UNASSIGNED_LOCATION = 'ยังไม่ระบุที่ตั้ง';

const ASSET_NO = 'COM-100-05-002';
/** ท่อนแรก = รหัสหมวด, ท่อนสาม = cost center ของแผนก (ดู parseAssetClass) */
const SAP_ASSET_CLASS = '1216401-0-775';
/** รหัสจัดซื้อบนบรรทัด PO — ตัวเลขล้วน ไม่เข้ารูปแบบเลขสินทรัพย์ */
const PURCHASING_CODE = '1216401';

/** apply() รับ tx ของ drizzle — ในเทสต์ยิงตรงเข้า PGlite ได้ ไม่ต้องห่อทรานแซกชัน */
const tx = db as unknown as Tx;

function sapRow(over: Partial<LegacyAssetRow> = {}): LegacyAssetRow {
  return {
    assetNumber: ASSET_NO,
    description: 'ชื่อจาก SAP',
    isActive: 'Y',
    createDate: new Date('2026-01-05'),
    updateDate: new Date('2026-08-20'),
    assetClass: SAP_ASSET_CLASS,
    uom: 'EA',
    serialNumber: 'SN-จาก-SAP',
    locationCode: null,
    employeeCode: null,
    acqDate: null,
    vendor: null,
    invoiceNo: null,
    acqCost: null,
    // ชุดบัญชีมาในคิวรีเดียวกันแล้ว — ไฟล์นี้ไม่ได้ทดสอบส่วนนั้น ปล่อยว่างทั้งชุด
    // (ทดสอบแยกที่ asset-accounting-sync.test.ts)
    ...NO_ACCOUNTING,
    ...over,
  };
}

/** ชิ้นที่ SAP ยังไม่มียอดบัญชีให้ — LEFT JOIN ITM8 ไม่เจอคู่ ทุกช่องจึงเป็น null พร้อมกัน */
const NO_ACCOUNTING = {
  fiscalYear: null,
  bookedCost: null,
  bookedCostHistorical: null,
  accumulatedDepreciation: null,
  salvageValue: null,
  unplannedDep: null,
  specialDep1: null,
  specialDep2: null,
  specialDep3: null,
  writeUp: null,
  appreciation: null,
  usefulLifeMonths: null,
  remainingLifeMonths: null,
  depreciationMethod: null,
  depreciationStart: null,
  depreciationEnd: null,
} satisfies Partial<LegacyAssetRow>;

/**
 * เลขที่ AMS ไม่มี — ใช้เป็นตัวประกอบให้ผลจาก SAP ไม่ว่าง
 *
 * apply() ออกตั้งแต่บรรทัดแรกถ้าทะเบียนสินทรัพย์ว่าง (กันรายงานช่องว่างสรุปผิดทั้งระบบ)
 * เทสต์ที่ไม่ได้สนใจสายเลขสินทรัพย์จึงต้องมีอย่างน้อยหนึ่งแถวเสมอ — ตัวนี้จะถูกสร้างเป็น
 * สินทรัพย์ SAP_LEGACY หนึ่งชิ้น ซึ่งเป็นพฤติกรรมปกติของ connector ไม่ใช่ผลข้างเคียงที่ผิด
 */
const DECOY_NO = 'ZZZ-999-99-999';
const decoyRow = () => sapRow({ assetNumber: DECOY_NO, assetClass: null, uom: null });

const pull = (assets: LegacyAssetRow[], purchasing: PurchasingItemRow[] = []): LegacyAssetPull => ({
  assets,
  purchasing,
});

const purchasingRow = (over: Partial<PurchasingItemRow> = {}): PurchasingItemRow => ({
  itemCode: PURCHASING_CODE,
  description: 'เครื่องใช้สำนักงาน',
  assetClass: SAP_ASSET_CLASS,
  uom: 'EA',
  ...over,
});

/** ค่าฝั่ง AMS ที่ต้องรอดจากทุกรอบ sync — ตั้งให้ "ชนกัน" กับที่ SAP ส่งมาทุกช่อง */
interface AmsSide {
  assetId: number;
  poItemId: string;
  poNumber: string;
  locationId: number;
  departmentId: number;
  employeeId: number;
  userId: number;
}

async function seedMasters() {
  await db.insert(assetLocation).values({ code: 'UNASSIGNED', name: UNASSIGNED_LOCATION });
  await db.insert(category).values({ code: '1216401', name: 'เครื่องใช้สำนักงาน' });
  // ปลายทางที่ SAP ชี้มา (assetClass ท่อนสาม / locationCode / employeeCode) — มีอยู่จริงใน
  // AMS ทั้งหมด เพื่อให้ resolve สำเร็จ เทสต์จะได้พิสูจน์ว่า "ไม่เขียน" ไม่ใช่ "เขียนไม่ได้"
  const [sapDept] = await db
    .insert(department)
    .values({ name: 'แผนกที่ SAP ชี้มา', departmentId: '775' })
    .returning();
  await db.insert(assetLocation).values({
    code: 'SAP-LOC',
    name: 'ที่ตั้งที่ SAP ชี้มา',
    sapLocationId: 42,
  });
  const sapEmployeeId = await makeEmployee({ departmentId: sapDept!.id });
  await db.update(employee).set({ ownerCode: 999 }).where(eq(employee.id, sapEmployeeId));
}

/** สินทรัพย์หนึ่งชิ้นที่ลงทะเบียนผ่าน AMS ครบโซ่ PO (ck_asset_origin_chain บังคับทั้งชุด) */
async function makePoFlowAsset(
  opts: { assetNumber?: string | null; itemCode?: string | null; seq?: number } = {},
): Promise<AmsSide> {
  const seq = opts.seq ?? 1;
  const assetNumber = opts.assetNumber === undefined ? ASSET_NO : opts.assetNumber;

  const userId = await makeUser();
  const amsDepartmentId = (
    await db
      .insert(department)
      .values({ name: `แผนกของ AMS ${seq}`, departmentId: `10${seq}` })
      .returning()
  )[0]!.id;
  const amsEmployeeId = await makeEmployee({ departmentId: amsDepartmentId });
  const [amsLocation] = await db
    .insert(assetLocation)
    .values({ code: `AMS-LOC-${seq}`, name: `ห้องที่คนเดินไปสำรวจมาเอง ${seq}` })
    .returning();

  const { poNumber, itemIds } = await makePo(`PO-000${seq}`, [
    { poLine: 0, quantity: 1, unitPrice: 1000 },
  ]);
  const poItemId = itemIds[0]!;
  if (opts.itemCode !== undefined && opts.itemCode !== null) {
    await db
      .update(purchaseOrderItem)
      .set({ itemCode: opts.itemCode })
      .where(eq(purchaseOrderItem.id, poItemId));
  }
  const { grpoLineId } = await makeGrpo(`GR-000${seq}`, poItemId, 1);
  const requestId = await makeRequest(poNumber, userId);

  const [row] = await db
    .insert(asset)
    .values({
      origin: 'PO_FLOW',
      requestId,
      grpoLineId,
      poItemId,
      unitNo: 1,
      acquisitionCost: 1000,
      createdBy: userId,
      updatedBy: userId,
      assetNumber,
      // ไม่มีเลข = ยังลงทะเบียนไม่เสร็จ (ck_asset_registered_needs_number ห้าม REGISTERED ที่ไม่มีเลข)
      lifecycle: assetNumber ? ('REGISTERED' as const) : ('DRAFT' as const),
      description: 'ชื่อที่คนกรอกเอง',
      serialNumber: 'SN-ที่คนกรอกเอง',
      locationId: amsLocation!.id,
      departmentId: amsDepartmentId,
      employeeId: amsEmployeeId,
    })
    .returning();

  return {
    assetId: row!.id,
    poItemId,
    poNumber,
    locationId: amsLocation!.id,
    departmentId: amsDepartmentId,
    employeeId: amsEmployeeId,
    userId,
  };
}

const readAsset = async (id: number) =>
  (await db.query.asset.findFirst({ where: eq(asset.id, id) }))!;

const categoryId = async () =>
  (await db.select().from(category).where(eq(category.code, '1216401')))[0]!.id;

beforeEach(async () => {
  await resetDb();
  await seedMasters();
});

describe('สายที่ 3 — PO_FLOW ที่มีเลขสินทรัพย์แล้ว', () => {
  test('เติม assetClass/categoryId/uom ให้ แต่ไม่แตะคอลัมน์ที่ AMS เป็นเจ้าของ', async () => {
    const ams = await makePoFlowAsset();

    await assetConnector.apply(tx, pull([sapRow({ locationCode: 42, employeeCode: 999 })]));

    const row = await readAsset(ams.assetId);

    // ── สามช่องที่ SAP เป็นเจ้าของ: ต้องเติมให้
    expect(row.assetClass).toBe(SAP_ASSET_CLASS);
    expect(row.uom).toBe('EA');
    expect(row.categoryId).toBe(await categoryId());

    // ── ที่เหลือต้องเป็นของ AMS เหมือนเดิมทุกช่อง ถึงแม้ SAP จะส่งค่าที่ resolve ได้มาก็ตาม
    expect(row.origin).toBe('PO_FLOW');
    expect(row.description).toBe('ชื่อที่คนกรอกเอง');
    expect(row.serialNumber).toBe('SN-ที่คนกรอกเอง');
    expect(row.locationId).toBe(ams.locationId);
    expect(row.departmentId).toBe(ams.departmentId);
    expect(row.employeeId).toBe(ams.employeeId);
    expect(row.acquisitionCost).toBe(1000);
    // โซ่ PO ต้องอยู่ครบ — ถ้าหลุดแปลว่ามีใครไปเขียนทับทั้งแถวเข้าแล้ว
    expect(row.poItemId).not.toBeNull();
    expect(row.updatedBy).toBe(ams.userId);
  });

  test('SAP ไม่มีค่าให้ ไม่ล้างของเดิมทิ้ง', async () => {
    const ams = await makePoFlowAsset();
    await assetConnector.apply(tx, pull([sapRow()]));
    // รอบสอง SAP ส่งว่างมาทั้งสามช่อง (uom ว่างจริง 3 แถวใน OITM — ไม่ใช่เคสสมมติ)
    await assetConnector.apply(tx, pull([sapRow({ assetClass: null, uom: null })]));

    const row = await readAsset(ams.assetId);
    expect(row.uom).toBe('EA');
    expect(row.assetClass).toBe(SAP_ASSET_CLASS);
    expect(row.categoryId).not.toBeNull();
  });

  test('ไม่มีอะไรเปลี่ยน ต้องไม่ขยับ updatedAt', async () => {
    const ams = await makePoFlowAsset();
    await assetConnector.apply(tx, pull([sapRow()]));

    // ปักเวลาที่รู้ค่าแน่นอน แล้วยิงข้อมูลชุดเดิมซ้ำ — ถ้าเงื่อนไข IS DISTINCT FROM หลุด
    // ค่านี้จะถูก now() ทับทันที (อาการจริงคือแถวเด้งขึ้นหัวรายการ "แก้ล่าสุด" ทุกนาที
    // โดยที่ updatedBy ยังเป็นชื่อคนเดิม = เล่าเรื่องผิดว่าเขาเพิ่งแก้)
    const marker = '2020-01-01T00:00:00.000Z';
    await db.update(asset).set({ updatedAt: marker }).where(eq(asset.id, ams.assetId));

    await assetConnector.apply(tx, pull([sapRow()]));

    expect((await readAsset(ams.assetId)).updatedAt).toBe(marker);
  });

  test('นับเป็นแถวที่แตะ (rowsHeader) ไม่ใช่แถวที่ข้าม (rowsSkipped)', async () => {
    await makePoFlowAsset();

    const result = await assetConnector.apply(tx, pull([sapRow()]));

    expect(result.rowsHeader).toBe(1);
    expect(result.rowsSkipped).toBe(0);
    // ไม่ได้สร้างแถวใหม่ — ของเดิมมีอยู่แล้ว แค่เติมคอลัมน์
    expect(result.rowsLine).toBe(0);
    expect(await db.$count(asset)).toBe(1);
  });

  test('แถวที่ถูกลบไปแล้ว ไม่ถูกเติมและไม่ถูกปลุกคืนเป็น SAP_LEGACY', async () => {
    const ams = await makePoFlowAsset();
    await db
      .update(asset)
      .set({ deletedAt: '2026-08-10T00:00:00.000Z', deletedBy: ams.userId })
      .where(eq(asset.id, ams.assetId));

    const result = await assetConnector.apply(tx, pull([sapRow()]));

    expect(result.rowsSkipped).toBe(1);
    expect(result.rowsHeader).toBe(0);
    // ยังมีแถวเดียว (แถวที่ลบ) — ไม่มีตัวใหม่ถูกสร้างขึ้นมาแทน
    expect(await db.$count(asset)).toBe(1);
    const row = await readAsset(ams.assetId);
    expect(row.origin).toBe('PO_FLOW');
    expect(row.uom).toBeNull();
  });
});

describe('สายที่ 4 — PO_FLOW ที่ยังไม่มีเลขสินทรัพย์ (เติมจากรหัสจัดซื้อ)', () => {
  test('เติมสามช่องจากรหัสจัดซื้อบนบรรทัด PO', async () => {
    const ams = await makePoFlowAsset({ assetNumber: null, itemCode: PURCHASING_CODE });

    await assetConnector.apply(tx, pull([decoyRow()], [purchasingRow()]));

    const row = await readAsset(ams.assetId);
    expect(row.assetNumber).toBeNull();
    expect(row.assetClass).toBe(SAP_ASSET_CLASS);
    expect(row.uom).toBe('EA');
    expect(row.categoryId).toBe(await categoryId());
    // ของ AMS ยังอยู่ครบเหมือนเดิม
    expect(row.locationId).toBe(ams.locationId);
    expect(row.departmentId).toBe(ams.departmentId);
  });

  test('ไม่สร้างแถว asset จากรหัสจัดซื้อ', async () => {
    await makePoFlowAsset({ assetNumber: null, itemCode: PURCHASING_CODE });

    await assetConnector.apply(tx, pull([decoyRow()], [purchasingRow()]));

    // 2 = ชิ้นของ AMS + ตัวประกอบ DECOY ที่ถูกสร้างเป็น SAP_LEGACY ตามปกติ
    // ถ้ากลายเป็น 3 แปลว่ารหัสจัดซื้อถูก upsert เป็นสินทรัพย์ปลอมเข้าไปด้วย
    expect(await db.$count(asset)).toBe(2);
    const fake = await db.query.asset.findFirst({
      where: eq(asset.assetNumber, PURCHASING_CODE),
    });
    expect(fake).toBeUndefined();
  });

  test('ของหยาบไม่ทับของที่มาจากเลขสินทรัพย์', async () => {
    const ams = await makePoFlowAsset({ itemCode: PURCHASING_CODE });

    // เลขสินทรัพย์ให้ 'SET' ส่วนรหัสจัดซื้อให้ 'EA' — ของจากเลขสินทรัพย์ต้องชนะ
    await assetConnector.apply(
      tx,
      pull([sapRow({ uom: 'SET' })], [purchasingRow({ uom: 'EA' })]),
    );

    expect((await readAsset(ams.assetId)).uom).toBe('SET');
  });

  test('รหัสจัดซื้อไม่ตรงกับบรรทัด PO ก็ไม่เติมข้ามชิ้น', async () => {
    const ams = await makePoFlowAsset({ assetNumber: null, itemCode: '9999999' });

    await assetConnector.apply(tx, pull([decoyRow()], [purchasingRow()]));

    const row = await readAsset(ams.assetId);
    expect(row.uom).toBeNull();
    expect(row.categoryId).toBeNull();
  });
});

describe('รายงานช่องว่าง — เลขที่ AMS ถืออยู่ แต่ SAP ไม่รู้จัก', () => {
  test('บันทึกเลขที่หาไม่เจอ พร้อมใบ PO ให้บัญชีตามต่อ', async () => {
    const ams = await makePoFlowAsset();

    // SAP รอบนี้ไม่มีเลขของเราเลย มีแต่ตัวอื่น
    await assetConnector.apply(tx, pull([decoyRow()]));

    const gaps = await db.select().from(sapAssetUnknownNumber);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.assetId).toBe(ams.assetId);
    expect(gaps[0]!.assetNumber).toBe(ASSET_NO);
    expect(gaps[0]!.poNumber).toBe(ams.poNumber);
  });

  test('พอ SAP รู้จักแล้ว แถวต้องหลุดออกจากรายงาน', async () => {
    await makePoFlowAsset();
    await assetConnector.apply(tx, pull([decoyRow()]));
    expect(await db.$count(sapAssetUnknownNumber)).toBe(1);

    await assetConnector.apply(tx, pull([sapRow()]));

    expect(await db.$count(sapAssetUnknownNumber)).toBe(0);
  });

  test('ค้างข้ามรอบ: firstSeenAt ต้องไม่ถูกรีเซ็ต แต่ lastSeenAt ต้องขยับ', async () => {
    await makePoFlowAsset();
    await assetConnector.apply(tx, pull([decoyRow()]));

    const marker = '2020-01-01T00:00:00.000Z';
    await db.update(sapAssetUnknownNumber).set({ firstSeenAt: marker, lastSeenAt: marker });

    await assetConnector.apply(tx, pull([decoyRow()]));

    const [gap] = await db.select().from(sapAssetUnknownNumber);
    expect(gap!.firstSeenAt).toBe(marker);
    expect(gap!.lastSeenAt).not.toBe(marker);
  });

  // ── สามเคสข้างล่างคือของที่ "หลุดออกจากชุดสำรวจ" ไม่ใช่ "หาเจอแล้ว"
  //    ตอนแรกเขียนเป็น "ลบเฉพาะตัวที่หาเจอ" ทำให้แถวพวกนี้ค้างในรายงานตลอดกาล
  //    เจอตอนตรวจ sync จริงรอบแรก: ข้อมูลทดสอบ 19 ตัวจะลบยังไงก็ยังฟ้องอยู่
  test('ชิ้นที่ถูกลบทิ้ง ต้องหลุดจากรายงาน', async () => {
    const ams = await makePoFlowAsset();
    await assetConnector.apply(tx, pull([decoyRow()]));
    expect(await db.$count(sapAssetUnknownNumber)).toBe(1);

    await db
      .update(asset)
      .set({ deletedAt: '2026-08-20T00:00:00.000Z', deletedBy: ams.userId })
      .where(eq(asset.id, ams.assetId));
    await assetConnector.apply(tx, pull([decoyRow()]));

    expect(await db.$count(sapAssetUnknownNumber)).toBe(0);
  });

  test('เลขถูกล้างทิ้ง ต้องหลุดจากรายงาน', async () => {
    const ams = await makePoFlowAsset();
    await assetConnector.apply(tx, pull([decoyRow()]));
    expect(await db.$count(sapAssetUnknownNumber)).toBe(1);

    // ck_asset_registered_needs_number บังคับว่า REGISTERED ต้องมีเลข — ถอยเป็น DRAFT ด้วย
    await db
      .update(asset)
      .set({ assetNumber: null, lifecycle: 'DRAFT' })
      .where(eq(asset.id, ams.assetId));
    await assetConnector.apply(tx, pull([decoyRow()]));

    expect(await db.$count(sapAssetUnknownNumber)).toBe(0);
  });

  test('ชิ้นที่ยังไม่มีเลข ไม่ถูกนับเป็นช่องว่าง (คนละสถานะกัน)', async () => {
    await makePoFlowAsset({ assetNumber: null, itemCode: PURCHASING_CODE });

    await assetConnector.apply(tx, pull([decoyRow()], [purchasingRow()]));

    expect(await db.$count(sapAssetUnknownNumber)).toBe(0);
  });
});

describe('เลขที่ไม่เข้าสคีมาบริษัท', () => {
  // ★ เคยเป็นบั๊กที่แพงที่สุดของโมดูลนี้: ตัวกรองรูปแบบอยู่ใน WHERE ของ SQL ทำให้สินทรัพย์จริง
  //   396 ชิ้น (อาคารโรงงาน 27 ล้าน / reactor tank 11 ล้าน) ไม่เคยเข้าระบบเลยโดยไม่มีอะไรฟ้อง
  //   ตอนนี้ดึงเข้ามาเป็นสินทรัพย์ตามปกติแล้วติดธงแทน — เทสต์นี้กันไม่ให้ย้อนกลับไปทางเดิม
  const OFF_SCHEME = [
    'MAC-300-13-001.1', // ชิ้นส่วนย่อยของ Day Tank #1
    'MAC-212-13-001/1', // ถัง Silo
    'MAC-1-21/12-002', // เครื่องบรรจุ — คนละสคีมา
  ];

  test.each(OFF_SCHEME)('ดึง %s เข้าเป็นสินทรัพย์ตามปกติ ไม่ถูกคัดทิ้ง', async (assetNumber) => {
    const result = await assetConnector.apply(tx, pull([sapRow({ assetNumber })]));

    expect(result.rowsLine).toBe(1); // สร้างใหม่จริง
    const row = await db.query.asset.findFirst({ where: eq(asset.assetNumber, assetNumber) });
    expect(row).toBeDefined();
    expect(row!.origin).toBe('SAP_LEGACY');
    // ได้ข้อมูลจาก SAP ครบเหมือนชิ้นที่เลขเข้าสคีมาทุกอย่าง ไม่ได้ถูกลดชั้น
    expect(row!.assetClass).toBe(SAP_ASSET_CLASS);
    expect(row!.uom).toBe('EA');
  });

  test('QR ของเลขที่มี "/" ต้องถูก encode ไม่แตกเป็น path', async () => {
    // 'MAC-212-13-001/1' ถ้าต่อลง URL ดิบ ๆ จะกลายเป็นสองท่อน แล้ว QR พาไปหน้าที่ไม่มีอยู่จริง
    await assetConnector.apply(tx, pull([sapRow({ assetNumber: 'MAC-212-13-001/1' })]));

    const row = await db.query.asset.findFirst({
      where: eq(asset.assetNumber, 'MAC-212-13-001/1'),
    });
    expect(row!.qrCode).toBe(assetQrUrl('MAC-212-13-001/1'));
    expect(row!.qrCode).toContain('MAC-212-13-001%2F1');
  });

  test('ยังทำงานร่วมกับแถว PO_FLOW ที่มีเลขเข้าสคีมาได้ในรอบเดียวกัน', async () => {
    const ams = await makePoFlowAsset();

    const result = await assetConnector.apply(
      tx,
      pull([sapRow(), sapRow({ assetNumber: 'MAC-300-13-001.1' })]),
    );

    // 2 แถวที่แตะ = PO_FLOW ที่เติมสามคอลัมน์ + ตัวใหม่ที่สร้าง
    expect(result.rowsHeader).toBe(2);
    expect((await readAsset(ams.assetId)).uom).toBe('EA');
    expect(await db.$count(asset)).toBe(2);
  });
});

describe('QR ของสินทรัพย์ที่ sync มาจาก SAP', () => {
  // ของเก่า 2,700+ ชิ้นต้องติดสติกเกอร์เหมือนของที่ลงทะเบียนผ่าน AMS — ก่อนหน้านี้ connector
  // ไม่เติม qrCode ให้เลย ทั้งทะเบียนจึงไม่มี QR ให้พิมพ์สักใบ
  test('ชิ้นที่สร้างใหม่ได้ QR ทันทีในรอบเดียวกัน', async () => {
    await assetConnector.apply(tx, pull([sapRow()]));

    const row = await db.query.asset.findFirst({ where: eq(asset.assetNumber, ASSET_NO) });
    expect(row!.qrCode).toBe(assetQrUrl(ASSET_NO));
  });

  test('ของเดิมที่ยังไม่มี QR ต้องถูกเติมให้ในรอบถัดไป', async () => {
    // นี่คือทางที่ของ 2,700+ ชิ้นที่ sync เข้ามาก่อนหน้านี้จะได้ QR ย้อนหลัง
    await assetConnector.apply(tx, pull([sapRow()]));
    await db.update(asset).set({ qrCode: null }).where(eq(asset.assetNumber, ASSET_NO));

    await assetConnector.apply(tx, pull([sapRow()]));

    const row = await db.query.asset.findFirst({ where: eq(asset.assetNumber, ASSET_NO) });
    expect(row!.qrCode).toBe(assetQrUrl(ASSET_NO));
  });

  test('QR ค่าเก่าที่ไม่ตรง config ต้องถูกทับให้ตรงปัจจุบัน', async () => {
    // นี่คือทางกลับบ้านของเคสที่ sync ไปตอน APP_BASE_URL ยังเป็น localhost:
    // แก้ config แล้ว sync ใหม่ ทั้งทะเบียนต้องตามมาเอง ไม่ต้องไล่ UPDATE ด้วยมือ 2,700 แถว
    // (ถ้าเทสต์นี้ล้มเพราะมีคนเปลี่ยนกลับไป COALESCE = ค่าผิดจะถูกตรึงถาวร)
    await assetConnector.apply(tx, pull([sapRow()]));
    await db
      .update(asset)
      .set({ qrCode: 'http://localhost:5173/assets/COM-100-05-002' })
      .where(eq(asset.assetNumber, ASSET_NO));

    await assetConnector.apply(tx, pull([sapRow()]));

    const row = await db.query.asset.findFirst({ where: eq(asset.assetNumber, ASSET_NO) });
    expect(row!.qrCode).toBe(assetQrUrl(ASSET_NO));
  });

  test('แถว PO_FLOW ไม่ถูกแตะ — QR ของมันเกิดตอนบัญชีออกเลขให้', async () => {
    const ams = await makePoFlowAsset();
    await db
      .update(asset)
      .set({ qrCode: 'https://ams.example.com/assets/COM-100-05-002' })
      .where(eq(asset.id, ams.assetId));

    await assetConnector.apply(tx, pull([sapRow()]));

    expect((await readAsset(ams.assetId)).qrCode).toBe(
      'https://ams.example.com/assets/COM-100-05-002',
    );
  });
});
