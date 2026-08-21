// ═══ กติกา lock: ห้ามสองคนแก้ใบเดียวกันพร้อมกัน ═══
//
// lock ไม่ได้อยู่ที่ DB แต่อยู่ใน registry in-memory (presence.service) — "ถือ lock" แปลว่า
// เปิดสาย SSE ค้างไว้อยู่ ปิดสายเมื่อไหร่ก็ปล่อย
//
// ไฟล์นี้เป็นที่เดียวที่เรียก service ตรง ๆ โดยไม่ผ่าน helpers/registrar (ซึ่งหยิบ lock ให้
// อัตโนมัติ) เพราะสิ่งที่ทดสอบคือตัวด่านเอง ไม่ใช่กติกาของปุ่ม
//
// ★ ที่ต้องมีเทสต์ชุดนี้: ถ้าด่านหายไป สาย SSE จะเหลือแค่ป้ายบอกว่าใครใช้อยู่ ไม่ได้กันจริง
//   แล้วบัญชีคนที่สองจะเขียนทับงานคนแรกได้เงียบ ๆ ซึ่งเป็นอาการที่ไม่มีใครเห็นจนข้อมูลเพี้ยนแล้ว
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { assetRequest } from '@intrastucture/db/schema';
import { create } from '@modules/business/asset/asset.service';
import {
  approveRequest,
  assignAssetNumber,
  cancelAsset,
  confirmRegistration,
  rejectAsset,
  submitRequest,
  uncancelAsset,
} from '@modules/business/asset-request/asset-request.service';
import * as presence from '@modules/business/asset-request/presence.service';
import {
  makeApprovalChain,
  makeGrpo,
  makeLocation,
  makePo,
  makeRequest,
  makeUser,
  resetDb,
} from './helpers/factory';

let requesterId: number;
let financeA: number;
let financeB: number;
let locationId: number;

beforeEach(async () => {
  await resetDb();
  requesterId = await makeUser({ displayName: 'ผู้ขอทดสอบ' });
  financeA = await makeUser({ displayName: 'บัญชี ก', roleName: 'FINANCE' });
  financeB = await makeUser({ displayName: 'บัญชี ข', roleName: 'FINANCE' });
  locationId = await makeLocation();
});

/** เปิดสายค้างไว้เหมือน frontend ทำ — คืนตัวปิดสายไว้ใช้ตอนอยากทดสอบการปล่อย lock */
function open(scope: presence.Scope, requestId: number, userId: number, name = 'เทสต์') {
  const member = presence.subscribe(scope, requestId, { id: userId, name }, () => {});
  return () => presence.unsubscribe(scope, requestId, member);
}

/** ใบที่เดินมาถึงขั้นบัญชีแล้ว (APPROVED) พร้อมชิ้นที่รอออกเลข 2 ชิ้น */
async function approved(poNumber: string) {
  const chain = await makeApprovalChain();
  const po = await makePo(poNumber, [{ poLine: 1, quantity: 2, unitPrice: 1_000 }], {
    ownerPrId: chain.ownerPrId,
  });
  const g = await makeGrpo(`GR-${poNumber}`, po.itemIds[0]!, 2);
  const requestId = await makeRequest(poNumber, requesterId);
  const assetIds: number[] = [];
  for (let i = 0; i < 2; i++) {
    const a = await create(
      { requestId, grpoLineId: g.grpoLineId, locationId, serialNumber: `SN-${i}-${poNumber}` } as never,
      requesterId,
    );
    assetIds.push(a.id);
  }
  const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, requestId) });
  await submitRequest(requestId, row!.updatedAt, requesterId);
  await approveRequest(requestId, chain.managerUserId);
  return { requestId, assetIds };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('ด่าน lock ของขั้นบัญชี', () => {
  test('ไม่ได้เปิดสายเลย = กดปุ่มไหนก็ไม่ได้ แม้ role ถูกต้อง', async () => {
    const s = await approved('PO-L1');
    await expect(assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-001', financeA)).rejects.toThrow(
      /กำลังถูกผู้อื่นแก้ไข|ยังไม่ได้เปิดโหมดแก้ไข/,
    );
  });

  test('คนที่เปิดสายก่อนได้ lock และออกเลขได้จริง', async () => {
    const s = await approved('PO-L2');
    open('registration', s.requestId, financeA);

    const result = await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-002', financeA);
    expect(result.asset.assetNumber).toBe('COM-775-26-002');
  });

  test('บัญชีคนที่สองในใบเดียวกันถูกกันทุกปุ่ม ไม่ใช่แค่ปุ่มออกเลข', async () => {
    const s = await approved('PO-L3');
    open('registration', s.requestId, financeA); // ก ถือ lock
    open('registration', s.requestId, financeB); // ข ต่อคิว

    const blocked = /กำลังถูกผู้อื่นแก้ไข|ยังไม่ได้เปิดโหมดแก้ไข/;
    await expect(assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-003', financeB)).rejects.toThrow(blocked);
    await expect(rejectAsset(s.requestId, s.assetIds[0]!, 'ข้อมูลผิด', financeB, 'FINANCE')).rejects.toThrow(blocked);
    await expect(cancelAsset(s.requestId, s.assetIds[0]!, 'ไม่เอาแล้ว', financeB)).rejects.toThrow(blocked);
    await expect(uncancelAsset(s.requestId, s.assetIds[0]!, financeB)).rejects.toThrow(blocked);
    await expect(confirmRegistration(s.requestId, financeB)).rejects.toThrow(blocked);
  });

  test('lock เป็นของ "ใบ" ไม่ใช่ของ "ชิ้น" — ถือใบ A ไม่ได้แปลว่าแตะใบ B ได้', async () => {
    const a = await approved('PO-L4');
    const b = await approved('PO-L5');
    open('registration', a.requestId, financeA);

    await expect(assignAssetNumber(b.requestId, b.assetIds[0]!, 'COM-775-26-004', financeA)).rejects.toThrow(
      /กำลังถูกผู้อื่นแก้ไข|ยังไม่ได้เปิดโหมดแก้ไข/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// เหตุผลที่ต้องแยกห้อง: ใบเดียวกันมีงานสองฝั่งเกิดพร้อมกันได้จริง — บัญชีตีกลับชิ้นหนึ่ง
// ผู้ขอเข้ามาแก้ชิ้นนั้น ระหว่างที่บัญชียังออกเลขให้ชิ้นที่เหลืออยู่ ถ้าใช้ห้องเดียวกัน
// สองฝั่งจะเข้าคิวรอกันทั้งที่คนละงาน แล้วงานขั้นบัญชีจะค้างเพราะผู้ขอถือ lock อยู่
describe('ห้อง draft กับ registration แยกกันจริง', () => {
  test('ผู้ขอถือห้อง draft อยู่ ไม่ได้กันบัญชีออกเลข', async () => {
    const s = await approved('PO-L6');
    open('draft', s.requestId, requesterId); // ผู้ขอกำลังแก้ชิ้นที่ถูกตีกลับ
    open('registration', s.requestId, financeA); // บัญชีเปิดใบเดียวกัน

    expect(presence.isHolder('draft', s.requestId, requesterId)).toBe(true);
    expect(presence.isHolder('registration', s.requestId, financeA)).toBe(true);

    const result = await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-005', financeA);
    expect(result.asset.assetNumber).toBe('COM-775-26-005');
  });

  test('ถือห้อง draft ไม่ได้ให้สิทธิ์ในห้อง registration', async () => {
    const s = await approved('PO-L7');
    open('draft', s.requestId, financeA);

    expect(presence.isHolder('registration', s.requestId, financeA)).toBe(false);
    await expect(assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-006', financeA)).rejects.toThrow(
      /กำลังถูกผู้อื่นแก้ไข|ยังไม่ได้เปิดโหมดแก้ไข/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ชื่อคนที่ถือ lock (ไปโชว์บนหน้าตาราง)', () => {
  test('getHolder คืนชื่อที่ส่งเข้ามาตอนเปิดสาย ไม่ใช่แค่ id', async () => {
    const s = await approved('PO-L8');
    open('registration', s.requestId, financeA, 'บัญชี ก');

    expect(presence.getHolder('registration', s.requestId)).toEqual({ id: financeA, name: 'บัญชี ก' });
  });

  test('ยังไม่มีใครเปิดใบนี้ = ไม่มีคนถือ', async () => {
    const s = await approved('PO-L9');
    expect(presence.getHolder('registration', s.requestId)).toBeNull();
  });

  test('คนที่ต่อคิวไม่ได้แย่งชื่อ holder ไป', async () => {
    const s = await approved('PO-L10');
    open('registration', s.requestId, financeA, 'บัญชี ก');
    open('registration', s.requestId, financeB, 'บัญชี ข');

    expect(presence.getHolder('registration', s.requestId)).toEqual({ id: financeA, name: 'บัญชี ก' });
  });
});
