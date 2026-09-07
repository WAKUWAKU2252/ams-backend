// ═══ GET /assets/by-room/:subLocationId — ของในห้องหนึ่ง แบ่งหน้าทีละ 50 ═══
//
// เดิมเส้นนี้ตัดที่ 200 แถวตายตัว ชิ้นที่ 201 เป็นต้นไปจึงเปิดไม่ได้เลยทั้งในลิสต์และบนผัง
// (หน้าจอวาดหมุดจาก items ชุดเดียวกัน) ตอนนี้เลื่อนลิสต์ลงไปแล้วโหลดหน้าถัดไปต่อได้
//
// ★ สิ่งที่เทสต์ไฟล์นี้เฝ้าจริง ๆ คือ **ไล่ทุกหน้าแล้วต้องได้ครบ ไม่ซ้ำไม่ขาด**
//   ซึ่งขึ้นกับ orderBy ที่ต้องคงที่ข้ามหน้า — คอลัมน์แรกที่ใช้เรียง (posX) เป็น NULL ได้
//   และซ้ำกันได้ ถ้าไม่ปิดท้ายด้วย id ลำดับจะสลับเองระหว่างสองคำขอ แล้วชิ้นเดิมจะโผล่
//   สองหน้าส่วนอีกชิ้นหายไปเลย โดยไม่มี error อะไรให้เห็น
import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '@intrastucture/db';
import { asset } from '@intrastucture/db/schema';
import { findByRoom } from '@modules/business/asset/asset.service';
import { makeLocation, makePlanArea, makeSubLocation, resetDb, TEST_COMPANY } from './helpers/factory';

let locationId = 0;
let roomId = 0;
let otherRoomId = 0;
/**
 * เลขที่ใช้ไปแล้ว — ต้องเดินต่อข้ามการเรียก seed() ในเทสต์เดียวกัน
 *
 * uq_asset_number เป็น unique ที่ (companyCode, assetNumber) เทสต์ที่เรียก seed() สองรอบ
 * (คนละห้อง / ปักหมุดกับไม่ปัก) จะชนกันทันทีถ้าแต่ละรอบนับหนึ่งใหม่
 */
let seq = 0;

beforeEach(async () => {
  await resetDb();
  seq = 0;
  locationId = await makeLocation();
  const building = await makePlanArea();
  roomId = await makeSubLocation(building, { room: 'ห้องคลัง' });
  otherRoomId = await makeSubLocation(building, { room: 'ห้องอื่น' });
});

/**
 * ของเก่าจาก SAP — ใช้เพราะไม่ต้องมีโซ่ PO ครบชุดเหมือน PO_FLOW
 *
 * เลขสินทรัพย์เติมศูนย์ให้เรียงตามตัวอักษรตรงกับลำดับที่สร้าง — เทสต์ที่เช็คลำดับข้ามหน้า
 * ต้องเทียบกับลำดับที่คาดเดาได้ ('TST-9' มาก่อน 'TST-10' ถ้าไม่เติมศูนย์)
 */
async function seed(
  count: number,
  opts: {
    subLocationId?: number;
    pinned?: boolean;
    lifecycle?: 'DRAFT' | 'REGISTERED' | 'CANCELLED';
    deleted?: boolean;
  } = {},
) {
  const rows = Array.from({ length: count }, () => ({
    origin: 'SAP_LEGACY' as const,
    companyCode: TEST_COMPANY,
    // ck_asset_origin_chain บังคับเลขไว้ฝั่ง SAP_LEGACY ทุก lifecycle ไม่ใช่เฉพาะ REGISTERED
    assetNumber: `TST-${String(++seq).padStart(4, '0')}`,
    description: `ของทดสอบ ${seq}`,
    locationId,
    subLocationId: opts.subLocationId ?? roomId,
    lifecycle: opts.lifecycle ?? ('REGISTERED' as const),
    status: 'Active' as const,
    // ck_asset_pos_needs_sub_location: มีพิกัดได้ต่อเมื่อระบุห้องแล้ว ซึ่งทุกแถวที่นี่มีอยู่แล้ว
    posX: opts.pinned ? 0.2 : null,
    posY: opts.pinned ? 0.2 : null,
    deletedAt: opts.deleted ? new Date().toISOString() : null,
  }));
  await db.insert(asset).values(rows);
}

describe('แบ่งหน้าของในห้อง', () => {
  test('หน้าแรกได้ 50 ชิ้น และบอกว่ายังมีต่อ', async () => {
    await seed(120);

    const res = await findByRoom(roomId, { page: 1 });

    expect(res.items).toHaveLength(50);
    expect(res.pageSize).toBe(50);
    expect(res.page).toBe(1);
    // total เป็นของทั้งห้อง ไม่ใช่ของหน้านี้ — หน้าจอเอาไปโชว์ "N ชิ้น"
    expect(res.total).toBe(120);
    expect(res.hasMore).toBe(true);
  });

  test('หน้าสุดท้ายได้เศษที่เหลือ และบอกว่าหมดแล้ว', async () => {
    await seed(120);

    const res = await findByRoom(roomId, { page: 3 });

    expect(res.items).toHaveLength(20);
    expect(res.total).toBe(120);
    expect(res.hasMore).toBe(false);
  });

  // ★ ข้อที่ห้ามล้ม — ลำดับไม่คงที่ข้ามหน้าคือบั๊กที่ไม่มีอะไรฟ้อง
  test('ไล่ทุกหน้าแล้วได้ครบ ไม่ซ้ำไม่ขาด', async () => {
    await seed(120);

    const seen: number[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await findByRoom(roomId, { page });
      seen.push(...res.items.map((i) => i.id));
    }

    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  test('ห้องที่ของไม่ถึงหน้าเดียว → hasMore เป็น false ตั้งแต่หน้าแรก', async () => {
    await seed(7);

    const res = await findByRoom(roomId, { page: 1 });

    expect(res.items).toHaveLength(7);
    expect(res.total).toBe(7);
    expect(res.hasMore).toBe(false);
  });

  // หน้าจอไม่ควรยิงเลยหน้าสุดท้าย (hasMore กันไว้แล้ว) แต่ถ้ามีคนยิงตรง ๆ ต้องได้ลิสต์ว่าง
  // ไม่ใช่ error — และ hasMore ต้องเป็น false ไม่ใช่ true จนหน้าจอวนขอไม่หยุด
  test('ขอหน้าที่เลยของจริง → ว่าง ไม่พัง และไม่บอกว่ายังมีต่อ', async () => {
    await seed(10);

    const res = await findByRoom(roomId, { page: 5 });

    expect(res.items).toHaveLength(0);
    expect(res.total).toBe(10);
    expect(res.hasMore).toBe(false);
  });

  test('ห้องว่าง → ไม่มีอะไรเลยและไม่พัง', async () => {
    const res = await findByRoom(roomId, { page: 1 });

    expect(res.items).toHaveLength(0);
    expect(res.total).toBe(0);
    expect(res.hasMore).toBe(false);
  });

  test('นับเฉพาะของในห้องนั้น ห้องอื่นไม่ปน', async () => {
    await seed(3);
    await seed(5, { subLocationId: otherRoomId });

    const res = await findByRoom(roomId, { page: 1 });

    expect(res.total).toBe(3);
    expect(res.items).toHaveLength(3);
  });

  // ของที่ปักหมุดแล้วต้องมาก่อน — คนเปิดหน้าผังมาหาของบนแผนที่ ชิ้นที่ชี้ตำแหน่งได้มีค่ากว่า
  // และต้องจริงข้ามหน้าด้วย ไม่ใช่แค่ภายในหน้าเดียว
  test('ของที่ปักหมุดแล้วอยู่หน้าแรกทั้งหมด', async () => {
    await seed(60, { pinned: true });
    await seed(30);

    const first = await findByRoom(roomId, { page: 1 });
    const second = await findByRoom(roomId, { page: 2 });

    expect(first.items.every((i) => i.posX !== null)).toBe(true);
    // หน้าสองต้องยังมีของที่ปักหมุดเหลืออีก 10 ชิ้นก่อนถึงของที่ไม่ได้ปัก
    expect(second.items.filter((i) => i.posX !== null)).toHaveLength(10);
    expect(second.total).toBe(90);
  });

  test('ไม่ส่ง page มาเลย → ถือเป็นหน้าแรก', async () => {
    await seed(3);

    const res = await findByRoom(roomId);

    expect(res.page).toBe(1);
    expect(res.items).toHaveLength(3);
  });
});

// ═══ เอาเฉพาะของที่ลงทะเบียนแล้ว ═══
//
// ★ ทำไมต้องมีชุดนี้: docstring ของ findByRoom เคยเขียนไว้ว่า "ไม่กรอง REGISTERED เพื่อให้
//   ของที่ยังไม่ออกเลขโผล่ในผังด้วย" ซึ่งไม่ตรงกับโค้ดมาตั้งแต่แรก และไม่มีเทสต์คุมเลย
//   ผลคือหน้าจอมีป้าย "ยังไม่ออกเลข" รออยู่แบบไม่มีวันได้ทำงาน โดยไม่มีอะไรฟ้อง
//   ตัดสินใจแล้วว่าเอาแค่ REGISTERED — เทสต์ชุดนี้คือตัวที่ทำให้คำตัดสินนั้นอยู่กับที่
describe('เอาเฉพาะ REGISTERED', () => {
  test('DRAFT ไม่นับว่าอยู่ในห้อง', async () => {
    await seed(2);
    await seed(3, { lifecycle: 'DRAFT' });

    const res = await findByRoom(roomId);

    expect(res.total).toBe(2);
    expect(res.items).toHaveLength(2);
  });

  test('CANCELLED ไม่นับว่าอยู่ในห้อง', async () => {
    await seed(2);
    await seed(4, { lifecycle: 'CANCELLED' });

    const res = await findByRoom(roomId);

    expect(res.total).toBe(2);
    expect(res.items).toHaveLength(2);
  });

  test('ชิ้นที่ถูกลบไปแล้วไม่นับ', async () => {
    await seed(2);
    await seed(5, { deleted: true });

    const res = await findByRoom(roomId);

    expect(res.total).toBe(2);
    expect(res.items).toHaveLength(2);
  });

  // total กับ items ต้องกรองด้วยเงื่อนไขชุดเดียวกันเสมอ — สองคิวรีคนละก้อนจึงหลุดกันได้
  // แล้วหน้าจอจะโชว์ "12 ชิ้น" แต่เลื่อนยังไงก็เจอแค่ 2 (หรือกลับกัน วนขอหน้าถัดไปไม่หยุด)
  test('total กับ items กรองเหมือนกัน แม้ห้องจะมีของทุกสถานะปนกัน', async () => {
    await seed(60);
    await seed(10, { lifecycle: 'DRAFT' });
    await seed(10, { lifecycle: 'CANCELLED' });
    await seed(10, { deleted: true });

    const first = await findByRoom(roomId, { page: 1 });
    const second = await findByRoom(roomId, { page: 2 });

    expect(first.total).toBe(60);
    expect(first.items).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.items).toHaveLength(10);
    expect(second.hasMore).toBe(false);
  });
});
