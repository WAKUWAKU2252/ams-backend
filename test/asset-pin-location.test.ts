// ═══ หมุดตำแหน่งบนผัง (posX/posY) + สองแกนของสถานที่ ═══
//
// 0022 แยก "สถานที่" ออกเป็นสองแกนที่ไม่เกี่ยวกัน:
//   asset.locationId              = สถานที่ทางบัญชี ยกมาจาก OLCT ของ SAP (ส่งต่อให้บัญชี)
//   asset.subLocationId -> ตึก    = ของตั้งอยู่ตรงไหนจริง ๆ บนผัง
// 0023 เปิดให้ API รับ posX/posY (คอลัมน์มีมาตั้งแต่ 0007 แต่ไม่เคยมีใครเขียน)
//
// สามเรื่องที่เทสต์ไฟล์นี้เฝ้า เพราะผิดแล้ว "พังเงียบ" ทั้งหมด — ไม่มี error ให้เห็น
// มีแต่หมุดที่ชี้ผิดห้องหรือยอดที่ไปโผล่ผิดสถานที่ในรายงานบัญชี:
//   1. ย้ายห้องแล้วหมุดเก่าต้องหายไป (พิกัดเดิมยังผ่าน CHECK ทุกข้อ DB จับให้ไม่ได้)
//   2. ตึกของผังต้องใส่เป็น asset.locationId ไม่ได้
//   3. ห้องกับสถานที่บัญชีต้องอยู่คนละตึกกันได้ (ด่านเดิมที่บังคับให้ตรงกันถูกถอดใน 0023)
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { create, update } from '@modules/business/asset/asset.service';
import { db } from '@intrastucture/db';
import { asset } from '@intrastucture/db/schema';
import {
  declare,
  makeGrpo,
  makeLocation,
  makePlanArea,
  makePo,
  makeRequest,
  makeSubLocation,
  makeUser,
  resetDb,
} from './helpers/factory';

let userId: number;
let locationId: number;
let buildingId: number;
let roomA: number;
let roomB: number;
let requestId: number;
let grpoLineId: string;

beforeEach(async () => {
  await resetDb();
  userId = await makeUser();
  locationId = await makeLocation();
  buildingId = await makePlanArea();
  roomA = await makeSubLocation(buildingId, { room: 'ห้อง A' });
  roomB = await makeSubLocation(buildingId, { room: 'ห้อง B', floor: '2', planKey: 'floor-2' });

  const po = await makePo('PO-PIN-1', [{ poLine: 1, quantity: 5, unitPrice: 100 }]);
  const grpo = await makeGrpo('GRPO-PIN-1', po.itemIds[0]!, 5);
  requestId = await makeRequest(po.poNumber, userId);
  await declare(requestId, grpo.grpoLineId, 5, userId);
  grpoLineId = grpo.grpoLineId;
});

/** ลงทะเบียน 1 ชิ้นด้วยค่าต่ำสุดที่ createAssetBody ต้องการ + ที่เทสต์นั้นสนใจ */
function register(extra: Record<string, unknown> = {}) {
  return create(
    { requestId, grpoLineId, locationId, serialNumber: `SN-${Math.random()}`, ...extra } as never,
    userId,
  );
}

const reload = async (id: number) =>
  db.query.asset.findFirst({ where: eq(asset.id, id) });

describe('ปักหมุดตอนสร้าง', () => {
  test('เลือกห้องแล้วปักหมุด — เก็บพิกัดครบคู่', async () => {
    const row = await register({ subLocationId: roomA, posX: 0.2, posY: 0.25 });
    expect(row.subLocationId).toBe(roomA);
    expect(row.posX).toBe(0.2);
    expect(row.posY).toBe(0.25);
  });

  test('เลือกห้องเฉย ๆ ไม่ปักหมุดก็บันทึกได้ (ไม่บังคับ)', async () => {
    const row = await register({ subLocationId: roomA });
    expect(row.subLocationId).toBe(roomA);
    expect(row.posX).toBeNull();
    expect(row.posY).toBeNull();
  });

  test('ปักหมุดโดยไม่เลือกห้อง — ปฏิเสธพร้อมบอกสาเหตุ', async () => {
    expect(register({ posX: 0.2, posY: 0.25 })).rejects.toThrow('ต้องเลือกห้องก่อน');
  });

  test('ส่งพิกัดมาข้างเดียว — ปฏิเสธ', async () => {
    expect(register({ subLocationId: roomA, posX: 0.2 })).rejects.toThrow('ทั้ง posX และ posY');
  });
});

describe('สองแกนของสถานที่', () => {
  test('ตึกของผังใส่เป็นสถานที่ทางบัญชีไม่ได้', async () => {
    expect(register({ locationId: buildingId })).rejects.toThrow('ไม่ใช่สถานที่ทางบัญชี');
  });

  test('ห้องอยู่คนละตึกกับสถานที่บัญชีได้ — ด่านเดิมที่บังคับให้ตรงกันถูกถอดแล้ว', async () => {
    // ก่อน 0023 เคสนี้โดน "ตำแหน่งย่อยที่เลือกไม่ได้อยู่ในสถานที่นี้" ทุกครั้ง
    // ซึ่งแปลว่าเลือกห้องพร้อมสถานที่บัญชีไม่ได้เลยสักครั้งเดียว
    const row = await register({ subLocationId: roomA });
    expect(row.locationId).toBe(locationId);
    expect(row.subLocationId).toBe(roomA);
  });
});

describe('ย้ายห้องแล้วหมุดต้องไม่ค้าง', () => {
  test('ย้ายห้องโดยไม่ปักใหม่ — ล้างหมุดเก่าอัตโนมัติ', async () => {
    const created = await register({ subLocationId: roomA, posX: 0.2, posY: 0.25 });

    await update(created.id, { subLocationId: roomB } as never, userId);

    const row = await reload(created.id);
    expect(row?.subLocationId).toBe(roomB);
    expect(row?.posX).toBeNull();
    expect(row?.posY).toBeNull();
  });

  test('ย้ายห้องพร้อมปักหมุดใหม่ — ใช้หมุดใหม่ ไม่ถูกล้างทิ้ง', async () => {
    const created = await register({ subLocationId: roomA, posX: 0.2, posY: 0.25 });

    await update(created.id, { subLocationId: roomB, posX: 0.7, posY: 0.8 } as never, userId);

    const row = await reload(created.id);
    expect(row?.subLocationId).toBe(roomB);
    expect(row?.posX).toBe(0.7);
    expect(row?.posY).toBe(0.8);
  });

  test('แก้ช่องอื่นโดยไม่แตะห้อง — หมุดเดิมอยู่ครบ', async () => {
    const created = await register({ subLocationId: roomA, posX: 0.2, posY: 0.25 });

    await update(created.id, { description: 'แก้คำอธิบายเฉย ๆ' } as never, userId);

    const row = await reload(created.id);
    expect(row?.posX).toBe(0.2);
    expect(row?.posY).toBe(0.25);
  });

  test('ส่ง posX/posY เป็น null — ถอนหมุดโดยยังอยู่ห้องเดิม', async () => {
    const created = await register({ subLocationId: roomA, posX: 0.2, posY: 0.25 });

    await update(created.id, { posX: null, posY: null } as never, userId);

    const row = await reload(created.id);
    expect(row?.subLocationId).toBe(roomA);
    expect(row?.posX).toBeNull();
  });
});
