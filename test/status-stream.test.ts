// ═══ สาย realtime ของสถานะ: ยัดลงสาย presence/lobby เดิม ไม่เปิดสายที่สาม ═══
//
// สิ่งที่ไฟล์นี้เฝ้าไว้ ไม่ใช่ "SSE ทำงานไหม" แต่เป็นสามข้อที่พังแล้วไม่มีใครเห็น:
//
//   1. ข้ามฝั่งได้จริง — บัญชีตีกลับชิ้นหนึ่ง ผู้ขอที่เปิดใบเดียวกันอยู่ (ห้อง draft คนละห้องกับ
//      registration) ต้องได้ก้อนนั้นด้วย ถ้าลืม loop SCOPES ฝั่งผู้ขอจะเงียบสนิทโดยที่ฝั่ง
//      บัญชียังเห็นอัปเดตปกติ — เทสต์มือจะจับไม่ได้เลยถ้าเปิดทดสอบทีละหน้า
//
//   2. actorId ต้องเป็นคนที่กด — frontend ใช้ค่านี้ทิ้งก้อน echo ของตัวเอง ถ้าค่าเพี้ยน
//      คนที่กำลังกรอกอยู่จะถูกโหลดทับแล้วสิ่งที่พิมพ์ค้างในกล่องหายไปเฉย ๆ
//
//   3. ห้ามยิงก่อน commit / ห้ามยิงตอนล้ม — ยิงจากในทรานแซกชันแปลว่าคนที่ได้ก้อนไปโหลดใหม่
//      ทันทีแล้วเห็นข้อมูลเก่า จอค้างถาวรเพราะไม่มี event รอบสองมาแก้ให้ อาการเหมือน
//      realtime พังทั้งที่โค้ดยิงครบทุกจุด
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { assetRequest } from '@intrastucture/db/schema';
import { create, update } from '@modules/business/asset/asset.service';
import {
  approveRequest,
  assignAssetNumber,
  cancelAsset,
  rejectAsset,
  submitRequest,
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
let financeId: number;
let locationId: number;

beforeEach(async () => {
  await resetDb();
  requesterId = await makeUser({ displayName: 'ผู้ขอทดสอบ' });
  financeId = await makeUser({ displayName: 'บัญชีทดสอบ', roleName: 'FINANCE' });
  locationId = await makeLocation();
});

/**
 * เข้าห้อง presence แล้วเก็บเฉพาะก้อน 'status' ไว้
 *
 * เรียก subscribe ตรง ๆ ไม่ผ่าน helpers/registrar เพราะตัวนั้น resetRooms() ก่อนหยิบ lock
 * ให้ — ซึ่งจะล้างผู้ฟังที่เทสต์นี้เพิ่งเข้าห้องไปทิ้งหมด
 */
function watchRoom(scope: presence.Scope, requestId: number, userId: number) {
  const seen: presence.StatusChange[] = [];
  presence.subscribe(scope, requestId, { id: userId, name: 'เทสต์' }, (e) => {
    if (e.event === 'status') seen.push(e.data as presence.StatusChange);
  });
  return seen;
}

/**
 * หยิบ lock ห้อง registration แบบไม่ล้างห้อง
 *
 * helpers/factory.holdRegistration ใช้ไม่ได้ที่นี่ — มันเรียก resetRooms() ก่อนเสมอ ซึ่งจะ
 * ล้างทั้งสมาชิกห้องและผู้ฟัง lobby ที่เทสต์นี้ตั้งใจเปิดค้างไว้ทิ้งไปด้วย
 */
function hold(requestId: number, userId: number): void {
  presence.subscribe('registration', requestId, { id: userId, name: 'เทสต์' }, () => {});
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * เปิดสาย lobby จริง ๆ แบบที่ route ทำ แล้วเก็บก้อนที่ไหลออกมา
 *
 * ต้องขับ generator เอง: createSseStream ยิง 'connected' ออกก่อน แล้วค่อยลงทะเบียน push
 * ตอนถูกขอก้อนถัดไป — ถ้าไม่รอจังหวะนั้น notifyStatus จะยิงตอนที่ยังไม่มีใครฟังอยู่เลย
 */
async function watchLobby() {
  const seen: presence.StatusChange[] = [];
  const controller = new AbortController();
  const gen = presence.openRegistrationLobby(controller.signal);
  void (async () => {
    for await (const chunk of gen) {
      const c = chunk as { event?: string; data?: unknown };
      if (c.event === 'status') seen.push(c.data as presence.StatusChange);
    }
  })();
  // รอให้ 'connected' ถูกดูดออกไปแล้ว setup() ได้ลงทะเบียน push เรียบร้อย
  await tick();
  await tick();
  return { seen, close: () => controller.abort() };
}

/**
 * เปิดสายของหน้า "คำขอของฉัน" แล้วเก็บก้อนที่ไหลออกมา
 *
 * เก็บก้อนดิบทั้งอัน ไม่ใช่แค่ action — เทสต์ต้องยืนยันได้ว่า **ไม่มี** requestId/actorId
 * ติดออกไปด้วย ซึ่งเป็นเหตุผลทั้งหมดที่สายนี้ไม่ต้องมี requireRole
 */
async function watchMyRequests() {
  const seen: unknown[] = [];
  const controller = new AbortController();
  const gen = presence.openMyRequestsChanges(controller.signal);
  void (async () => {
    for await (const chunk of gen) {
      const c = chunk as { event?: string; data?: unknown };
      if (c.event === 'changed') seen.push(c.data);
    }
  })();
  await tick();
  await tick();
  return { seen, close: () => controller.abort() };
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
describe('กระจายสถานะลงสายที่เปิดอยู่แล้ว', () => {
  test('บัญชีออกเลข → ทั้งห้องบัญชีและห้องผู้ขอของใบเดียวกันได้ก้อนเดียวกัน', async () => {
    const s = await approved('PO-S1');
    const finance = watchRoom('registration', s.requestId, financeId);
    const requester = watchRoom('draft', s.requestId, requesterId);

    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-001', financeId);

    expect(finance).toEqual([
      {
        requestId: s.requestId,
        action: 'asset-numbered',
        requestStatus: 'APPROVED',
        assetId: s.assetIds[0]!,
        actorId: financeId,
      },
    ]);
    // ★ ข้อที่พังง่ายที่สุด: ห้อง draft เป็นคนละห้องกับ registration ทั้งที่เป็นใบเดียวกัน
    expect(requester).toEqual(finance);
  });

  test('ใบที่ไม่มีใครเปิดค้าง ก็ยังถึงหน้าคิวของบัญชี (สาย lobby)', async () => {
    const s = await approved('PO-S2');
    hold(s.requestId, financeId);
    const lobby = await watchLobby();
    try {
      await cancelAsset(s.requestId, s.assetIds[0]!, 'นับเกิน', financeId);
      // ห้อง presence เก็บก้อนใส่ array ตรง ๆ แต่ lobby ไหลผ่าน generator — ต้องปล่อยให้มัน
      // ปลุกตัวเองแล้ว yield ออกมาก่อน ไม่ใช่เช็คทันทีที่ notifyStatus คืนค่า
      await tick();
      await tick();

      expect(lobby.seen).toEqual([
        {
          requestId: s.requestId,
          action: 'asset-cancelled',
          requestStatus: 'APPROVED',
          assetId: s.assetIds[0]!,
          actorId: financeId,
        },
      ]);
    } finally {
      lobby.close();
    }
  });

  test('ใบร่างที่ยังไม่อนุมัติ ห้ามไหลไปหน้าคิวบัญชี — แต่ห้องของผู้ขอต้องได้', async () => {
    const chain = await makeApprovalChain();
    const po = await makePo('PO-S5', [{ poLine: 1, quantity: 1, unitPrice: 500 }], {
      ownerPrId: chain.ownerPrId,
    });
    const g = await makeGrpo('GR-PO-S5', po.itemIds[0]!, 1);
    const requestId = await makeRequest('PO-S5', requesterId);

    const lobby = await watchLobby();
    const requester = watchRoom('draft', requestId, requesterId);
    try {
      await create(
        { requestId, grpoLineId: g.grpoLineId, locationId, serialNumber: 'SN-ร่าง' } as never,
        requesterId,
      );
      await tick();
      await tick();

      // ★ คิวของบัญชีมีแค่ใบ APPROVED — ผู้ขอทุกคนที่กรอกชิ้นเข้าใบร่างของตัวเองต้องไม่ทำให้
      //   ตารางของบัญชีทุกคนโหลดใหม่ฟรี ๆ และ requestId ของใบร่างข้ามแผนกต้องไม่ไหลออกไป
      expect(lobby.seen).toEqual([]);
      expect(requester.map((e) => [e.action, e.requestStatus])).toEqual([['asset-created', 'DRAFT']]);
    } finally {
      lobby.close();
    }
  });

  test('actorId คือคนที่กด ไม่ใช่คนที่ฟังอยู่ — frontend ใช้ค่านี้ทิ้ง echo ของตัวเอง', async () => {
    const s = await approved('PO-S3');
    const seen = watchRoom('registration', s.requestId, financeId);

    await rejectAsset(s.requestId, s.assetIds[0]!, 'S/N ไม่ตรง', financeId, 'FINANCE');
    // ผู้ขอแก้ชิ้นที่ถูกตีกลับ → ชิ้นกลับเข้าคิวบัญชีเอง คนละ actor กับก้อนแรก
    await update(s.assetIds[0]!, { serialNumber: 'SN-แก้แล้ว' } as never, requesterId);

    expect(seen.map((e) => [e.action, e.actorId])).toEqual([
      ['asset-rejected', financeId],
      ['asset-updated', requesterId],
    ]);
  });

  // ── สายของหน้า "คำขอของฉัน" ────────────────────────────────────────────────
  test('บัญชีตีกลับรายชิ้น → หน้าคำขอของฉันได้สัญญาณ และในก้อนไม่มี requestId เลย', async () => {
    const s = await approved('PO-S6');
    hold(s.requestId, financeId);
    const mine = await watchMyRequests();
    try {
      await rejectAsset(s.requestId, s.assetIds[0]!, 'S/N ไม่ตรง', financeId, 'FINANCE');
      await tick();
      await tick();

      // ★ ต้องเป็น action เดี่ยว ๆ ไม่มีอะไรอื่น — สายนี้ถึงผู้ขอทุกคนที่เปิดหน้านั้นค้างอยู่
      //   โดยไม่ผ่าน requireRole ถ้ามี requestId ติดไปด้วย = ใบข้ามแผนกรั่วให้ทุกคน
      expect(mine.seen).toEqual([{ action: 'asset-rejected' }]);
    } finally {
      mine.close();
    }
  });

  test('ผู้ขอกรอกชิ้นเข้าใบร่าง ต้องไม่ปลุกหน้าคำขอของฉันของทุกคน', async () => {
    const chain = await makeApprovalChain();
    const po = await makePo('PO-S7', [{ poLine: 1, quantity: 2, unitPrice: 500 }], {
      ownerPrId: chain.ownerPrId,
    });
    const g = await makeGrpo('GR-PO-S7', po.itemIds[0]!, 2);
    const requestId = await makeRequest('PO-S7', requesterId);

    const mine = await watchMyRequests();
    try {
      const a = await create(
        { requestId, grpoLineId: g.grpoLineId, locationId, serialNumber: 'SN-ร่าง' } as never,
        requesterId,
      );
      // แก้ชิ้นตอนใบยังเป็น DRAFT ก็ไม่เปลี่ยนอะไรในลิสต์ (ลิสต์ไม่โชว์จำนวนชิ้น)
      await update(a.id, { serialNumber: 'SN-ร่าง-แก้' } as never, requesterId);
      await tick();
      await tick();

      // ★ สองก้อนนี้ยิงถี่ที่สุดในระบบ (กรอกทีละชิ้นรัว ๆ) ถ้าปล่อยผ่าน = refetch คูณจำนวน
      //   ผู้ขอที่เปิดหน้านั้นอยู่ ทุกครั้งที่ใครกรอกอะไรก็ตามในบริษัท
      expect(mine.seen).toEqual([]);
    } finally {
      mine.close();
    }
  });

  test('ผู้ขอแก้ชิ้นที่ถูกตีกลับ → ได้สัญญาณ (แถวหลุดจากลิสต์เมื่อแก้ชิ้นสุดท้าย)', async () => {
    const s = await approved('PO-S8');
    hold(s.requestId, financeId);
    await rejectAsset(s.requestId, s.assetIds[0]!, 'รูปไม่ชัด', financeId, 'FINANCE');

    const mine = await watchMyRequests();
    try {
      await update(s.assetIds[0]!, { serialNumber: 'SN-แก้แล้ว' } as never, requesterId);
      await tick();
      await tick();

      // ★ ไม่กรอง echo ของตัวเองที่สายนี้โดยตั้งใจ — คนที่แก้เสร็จต้องเห็นแถวตัวเองหลุดออก
      //   จากลิสต์ทันที ถ้ากรองทิ้งแถวจะค้างจนกว่าเขาจะกดโหลดใหม่เอง
      expect(mine.seen).toEqual([{ action: 'asset-updated' }]);
    } finally {
      mine.close();
    }
  });

  test('คำสั่งที่ล้ม (rollback) ต้องไม่ยิงก้อนออกไป', async () => {
    const s = await approved('PO-S4');
    hold(s.requestId, financeId);
    await cancelAsset(s.requestId, s.assetIds[0]!, 'ไม่เอาแล้ว', financeId);

    const seen = watchRoom('registration', s.requestId, financeId);
    // ชิ้นที่ปิดถาวรแล้วออกเลขไม่ได้ — ระเบิดจากในทรานแซกชัน ไม่มีอะไรถูก commit
    await expect(
      assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-004', financeId),
    ).rejects.toThrow(/ปิดถาวร/);

    // ยิงก่อน commit หรือยิงในทรานแซกชัน = ก้อนนี้จะโผล่มาแล้วพาให้ทุกจอโหลดของเก่าทับ
    expect(seen).toEqual([]);
  });
});
