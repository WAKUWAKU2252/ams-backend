// ═══ เพดานจำนวนชิ้น / unitNo / การนับข้ามใบ ═══
//
// สามเรื่องนี้อยู่ไฟล์เดียวกันเพราะเป็นกลไกเดียวกันที่มองจากคนละมุม และเป็นจุดที่ "พังเงียบ":
// ผิดแล้วไม่มี error ให้เห็น มีแต่ตัวเลขในทะเบียนสินทรัพย์ที่ไม่ตรงกับของจริงในโกดัง
//
// ทุกเทสต์ยิงผ่าน service จริงลง Postgres จริง (PGlite) — ไม่ mock ตัวนับ เพราะบั๊กที่
// ตามหาอยู่ในเงื่อนไข WHERE (ลืมกัน CANCELLED / ลืมกัน deletedAt / นับเฉพาะใบตัวเอง)
// ซึ่ง mock จะกลบให้หมด
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { create, findSlotsByRequest } from '@modules/business/asset/asset.service';
// ผ่าน helper ที่หยิบ lock ขั้นบัญชีให้ก่อน — ไฟล์นี้ทดสอบเพดานจำนวน ไม่ใช่กติกา lock
import { cancelAsset, uncancelAsset } from './helpers/registrar';
import { db } from '@intrastucture/db';
import { asset } from '@intrastucture/db/schema';
import {
  assetsOfPoItem,
  declare,
  makeGrpo,
  makeLocation,
  makePo,
  makeRequest,
  makeUser,
  resetDb,
  setRequestStatus,
} from './helpers/factory';

let userId: number;
let locationId: number;

beforeEach(async () => {
  await resetDb();
  userId = await makeUser();
  locationId = await makeLocation();
});

/** ลงทะเบียน 1 ชิ้นด้วยค่าต่ำสุดที่ createAssetBody ต้องการ */
function register(requestId: number, grpoLineId: string, extra: Record<string, unknown> = {}) {
  return create(
    { requestId, grpoLineId, locationId, serialNumber: `SN-${Math.random()}`, ...extra } as never,
    userId,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
describe('เพดานต่อรอบรับของ (GRPO round)', () => {
  test('รับมา 2 ชิ้น ลงได้ 2 ชิ้น — ชิ้นที่ 3 ต้องถูกปฏิเสธ', async () => {
    const po = await makePo('PO-A', [{ poLine: 1, quantity: 5, unitPrice: 100 }]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 2);
    const req = await makeRequest('PO-A', userId);

    await register(req, g.grpoLineId);
    await register(req, g.grpoLineId);

    expect(register(req, g.grpoLineId)).rejects.toThrow(/ลงทะเบียนครบแล้ว/);
    expect(await assetsOfPoItem(po.itemIds[0]!)).toHaveLength(2);
  });

  test('แจ้งจำนวนเอง (งานเหมา) เปิดเพดานให้เกิน receivedQty ได้', async () => {
    // PO สั่ง "1 งาน" ราคา 120,000 — GRPO รับมา 1 หน่วย แต่ของจริงคือกล้อง 5 ตัว
    const po = await makePo('PO-B', [{ poLine: 1, quantity: 1, unitPrice: 120_000 }]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 1);
    const req = await makeRequest('PO-B', userId);
    await declare(req, g.grpoLineId, 5, userId);

    for (let i = 0; i < 5; i++) await register(req, g.grpoLineId);

    expect(register(req, g.grpoLineId)).rejects.toThrow(/แจ้งไว้ 5 ชิ้น/);
    expect(await assetsOfPoItem(po.itemIds[0]!)).toHaveLength(5);
  });

  test('แจ้งจำนวน 0 = รอบนี้ไม่เกิดสินทรัพย์ — ลงไม่ได้เลยแม้แต่ชิ้นเดียว', async () => {
    const po = await makePo('PO-C', [{ poLine: 1, quantity: 3, unitPrice: 100 }]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 3);
    const req = await makeRequest('PO-C', userId);
    await declare(req, g.grpoLineId, 0, userId);

    expect(register(req, g.grpoLineId)).rejects.toThrow(/แจ้งไว้ 0 ชิ้น/);
  });

  test('receivedQty เป็นเศษ (2.5) — ปัดขึ้นเป็น 3 ช่อง และลงได้ 3 ชิ้น', async () => {
    const po = await makePo('PO-D', [{ poLine: 1, quantity: 3, unitPrice: 100 }]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 2.5);
    const req = await makeRequest('PO-D', userId);

    await register(req, g.grpoLineId);
    await register(req, g.grpoLineId);
    await register(req, g.grpoLineId); // ชิ้นเศษสุดท้ายต้องลงได้

    expect(register(req, g.grpoLineId)).rejects.toThrow();

    const slots = await findSlotsByRequest(req);
    expect(slots.items[0]!.slots).toHaveLength(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('เพดานต่อ PO line (จำนวนที่สั่ง)', () => {
  test('รับเกินจำนวนสั่งและไม่มีใครแจ้ง — บล็อกที่จำนวนสั่ง ไม่ใช่จำนวนรับ', async () => {
    // สั่ง 3 แต่ GRPO รับมา 5 (SAP ยอมรับเกินได้) — ถ้าไม่บล็อก ทะเบียนจะมีของเกิน PO
    const po = await makePo('PO-E', [{ poLine: 1, quantity: 3, unitPrice: 100 }]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 5);
    const req = await makeRequest('PO-E', userId);

    for (let i = 0; i < 3; i++) await register(req, g.grpoLineId);

    expect(register(req, g.grpoLineId)).rejects.toThrow(/สั่งไว้ 3 ชิ้น/);
  });

  test('มีการแจ้งจำนวนบนบรรทัดนั้น = เพดาน "จำนวนสั่ง" ถูกปลด', async () => {
    const po = await makePo('PO-F', [{ poLine: 1, quantity: 1, unitPrice: 100 }]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 4);
    const req = await makeRequest('PO-F', userId);
    await declare(req, g.grpoLineId, 4, userId);

    for (let i = 0; i < 4; i++) await register(req, g.grpoLineId);
    expect(await assetsOfPoItem(po.itemIds[0]!)).toHaveLength(4);
  });

  test('การแจ้งของ "รอบก่อน" ต้องปลดเพดานให้รอบใหม่ที่ไม่ได้แจ้งด้วย', async () => {
    // เคสจริงที่เคยพัง: รอบ 1 แจ้ง 3 ชิ้นบนงานเหมา (PO quantity = 1) รอบ 2 ไม่ได้แจ้ง
    // ถ้าดูเฉพาะการแจ้งของใบตัวเอง เพดาน quantity=1 จะกลับมา แล้วรอบ 2 ลงไม่ได้เลยสักชิ้น
    const po = await makePo('PO-G', [{ poLine: 1, quantity: 1, unitPrice: 100 }]);
    const g1 = await makeGrpo('GR-1', po.itemIds[0]!, 1);
    const g2 = await makeGrpo('GR-2', po.itemIds[0]!, 2);

    const req1 = await makeRequest('PO-G', userId);
    await declare(req1, g1.grpoLineId, 3, userId);
    for (let i = 0; i < 3; i++) await register(req1, g1.grpoLineId);
    await setRequestStatus(req1, 'APPROVED'); // ใบรอบก่อนปิดไปแล้ว

    const req2 = await makeRequest('PO-G', userId);
    await register(req2, g2.grpoLineId);
    await register(req2, g2.grpoLineId);

    expect(await assetsOfPoItem(po.itemIds[0]!)).toHaveLength(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('การนับข้ามใบคำขอ', () => {
  test('ใบใหม่บน PO เดิมต้องไม่เปิดช่องซ้ำของที่ใบก่อนลงไปแล้ว', async () => {
    const po = await makePo('PO-H', [{ poLine: 1, quantity: 2, unitPrice: 100 }]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 2);

    const req1 = await makeRequest('PO-H', userId);
    await register(req1, g.grpoLineId);
    await register(req1, g.grpoLineId);
    await setRequestStatus(req1, 'APPROVED'); // ใบรอบก่อนปิดไปแล้ว

    const req2 = await makeRequest('PO-H', userId);
    expect(register(req2, g.grpoLineId)).rejects.toThrow(/ลงทะเบียนครบแล้ว/);

    // และช่องบนหน้าจอของใบใหม่ต้องขึ้นเป็น registered ทั้งหมด ไม่ใช่ pending
    const slots = await findSlotsByRequest(req2);
    expect(slots.items[0]!.slots.map((s) => s.status)).toEqual(['registered', 'registered']);
  });

  test('unitNo เดินต่อข้ามใบ ไม่เริ่มนับ 1 ใหม่', async () => {
    const po = await makePo('PO-I', [{ poLine: 1, quantity: 4, unitPrice: 100 }]);
    const g1 = await makeGrpo('GR-1', po.itemIds[0]!, 2);
    const g2 = await makeGrpo('GR-2', po.itemIds[0]!, 2);

    const req1 = await makeRequest('PO-I', userId);
    await register(req1, g1.grpoLineId);
    await register(req1, g1.grpoLineId);
    await setRequestStatus(req1, 'APPROVED'); // ใบรอบก่อนปิดไปแล้ว

    const req2 = await makeRequest('PO-I', userId);
    await register(req2, g2.grpoLineId);
    await register(req2, g2.grpoLineId);

    expect((await assetsOfPoItem(po.itemIds[0]!)).map((a) => a.unitNo)).toEqual([1, 2, 3, 4]);
  });

  test('unitNo ที่ช่อง pending เสนอมา ต้องเป็นเลขถัดไปจริง ไม่ใช่ลำดับบนจอ', async () => {
    // บั๊กเดิม: ช่องบนจอของใบใหม่เริ่มที่ 1 เสมอ พอกดบันทึกจะชน uq_asset_po_item_unit_no ทุกครั้ง
    const po = await makePo('PO-J', [{ poLine: 1, quantity: 4, unitPrice: 100 }]);
    const g1 = await makeGrpo('GR-1', po.itemIds[0]!, 2);
    const g2 = await makeGrpo('GR-2', po.itemIds[0]!, 2);

    const req1 = await makeRequest('PO-J', userId);
    await register(req1, g1.grpoLineId);
    await register(req1, g1.grpoLineId);
    await setRequestStatus(req1, 'APPROVED'); // ใบรอบก่อนปิดไปแล้ว

    const req2 = await makeRequest('PO-J', userId);
    const slots = await findSlotsByRequest(req2);
    const pending = slots.items[0]!.slots.filter((s) => s.status === 'pending');
    expect(pending.map((s) => (s as { unitNo: number }).unitNo)).toEqual([3, 4]);
  });

  test('ส่ง unitNo ที่ชนกับของเดิม = 409 ไม่ใช่ 500', async () => {
    const po = await makePo('PO-K', [{ poLine: 1, quantity: 3, unitPrice: 100 }]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 3);
    const req = await makeRequest('PO-K', userId);

    await register(req, g.grpoLineId, { unitNo: 1 });
    expect(register(req, g.grpoLineId, { unitNo: 1 })).rejects.toThrow(
      /เพิ่งถูกลงทะเบียนโดยผู้อื่น/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('CANCELLED / soft delete กับการคืนช่อง', () => {
  test('★ ปิดถาวร (cancel) ไม่คืนช่อง — ลงชิ้นทดแทนไม่ได้', async () => {
    // กติกาตั้งแต่ 0016: cancel = "ของชิ้นนี้จะไม่เป็นสินทรัพย์" ปิดช่องไปเลย
    // ถ้าอยากให้ผู้ขอกลับมาแก้แล้วใช้ช่องเดิมต่อ ต้องใช้ปุ่ม reject รายชิ้น ไม่ใช่ cancel
    const po = await makePo('PO-L', [{ poLine: 1, quantity: 2, unitPrice: 100 }]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 2);
    const req = await makeRequest('PO-L', userId);

    const a1 = await register(req, g.grpoLineId);
    await register(req, g.grpoLineId);
    await cancelAsset(req, a1.id, 'นับเกิน', userId);

    expect(register(req, g.grpoLineId)).rejects.toThrow(/ลงทะเบียนครบแล้ว/);
    // และหน้าจอต้องไม่เปิดช่อง pending หลอกให้กรอกในสิ่งที่ service จะปฏิเสธ
    const slots = await findSlotsByRequest(req);
    expect(slots.items[0]!.slots.some((s) => s.status === 'pending')).toBe(false);
  });

  test('บัญชีปลดการปิดถาวรได้ แล้วชิ้นเดิมกลับมาแก้ต่อได้ (ไม่ใช่สร้างชิ้นใหม่)', async () => {
    const po = await makePo('PO-L2', [{ poLine: 1, quantity: 2, unitPrice: 100 }]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 2);
    const req = await makeRequest('PO-L2', userId);

    const a1 = await register(req, g.grpoLineId);
    await cancelAsset(req, a1.id, 'เข้าใจผิด', userId);
    const back = await uncancelAsset(req, a1.id, userId);

    expect(back.lifecycle).toBe('DRAFT');
    // ยังเป็นชิ้นเดิม เลข unitNo เดิม ไม่ได้เกิดแถวใหม่
    const rows = await assetsOfPoItem(po.itemIds[0]!);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.unitNo).toBe(1);
    expect(rows[0]!.cancelReason).toBeNull();
  });

  test('soft delete คืนทั้งช่องและคืนเลข unitNo ตัวท้ายให้ใช้ซ้ำ', async () => {
    const po = await makePo('PO-M', [{ poLine: 1, quantity: 2, unitPrice: 100 }]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 2);
    const req = await makeRequest('PO-M', userId);

    await register(req, g.grpoLineId);
    const a2 = await register(req, g.grpoLineId);
    await db.update(asset).set({ deletedAt: new Date().toISOString() }).where(eq(asset.id, a2.id));

    const a3 = await register(req, g.grpoLineId);
    expect(a3.unitNo).toBe(2);
    expect(await assetsOfPoItem(po.itemIds[0]!)).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ราคาตั้งต้นของชิ้นที่แตกเพิ่มเอง', () => {
  test('ชิ้นในโควตา SAP ได้ unitPrice / ชิ้นที่เกินได้ 0 (ทั้งบรรทัดแชร์ lineTotal ก้อนเดียว)', async () => {
    const po = await makePo('PO-N', [
      { poLine: 1, quantity: 1, unitPrice: 120_000, lineTotal: 120_000 },
    ]);
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 1);
    const req = await makeRequest('PO-N', userId);
    await declare(req, g.grpoLineId, 3, userId);

    const first = await register(req, g.grpoLineId);
    const second = await register(req, g.grpoLineId);
    const third = await register(req, g.grpoLineId);

    expect(first.acquisitionCost).toBe(120_000);
    expect(second.acquisitionCost).toBe(0);
    expect(third.acquisitionCost).toBe(0);
    // isSplitItem ต้องติดตัวทุกชิ้นที่เกิดจากการแจ้งจำนวนเอง
    expect([first, second, third].map((a) => a.isSplitItem)).toEqual([true, true, true]);
  });
});
