// ═══ สองปุ่มที่คนสับสนกันบ่อยที่สุด: reject รายชิ้น กับ cancel ═══
//
//   reject  ของมาถึงจริง จะลงทะเบียน แต่ข้อมูลผิด -> ผู้ขอแก้แล้วกลับเข้าคิว ช่องยังเป็นของชิ้นเดิม
//   cancel  ของจะไม่เป็นสินทรัพย์ (ส่งคืน/นับเกิน)  -> ปิดช่องถาวร ไม่มีชิ้นทดแทน
//
// ถ้าสองอันนี้เบลอเข้าหากันเมื่อไหร่ ระบบจะโกหกเรื่องจำนวนทันที: cancel ที่คืนช่องได้จะทำให้
// ทะเบียนมีของเกินจำนวนที่รับมาจริง ส่วน reject ที่ปิดช่องจะทำให้ของที่มีอยู่จริงลงทะเบียนไม่ได้เลย
//
// ── ไฟล์นี้ยังเก็บบั๊กที่ยังไม่ได้แก้ไว้เป็น test.failing (ท้ายไฟล์)
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { asset, assetRequest, employee } from '@intrastucture/db/schema';
import { create, findSlotsByRequest, update } from '@modules/business/asset/asset.service';
import {
  approveRequest,
  getPendingRegistration,
  submitRequest,
} from '@modules/business/asset-request/asset-request.service';
import { assetQrUrl } from '@common/app-url';
// ปุ่มของบัญชีผ่าน helper ที่หยิบ lock ขั้นบัญชีให้ก่อน — ไฟล์นี้ทดสอบ reject/cancel ไม่ใช่กติกา lock
import {
  assignAssetNumber,
  cancelAsset,
  rejectAsset,
  uncancelAsset,
} from './helpers/registrar';
import {
  holdRegistration,
  makeApprovalChain,
  makeGrpo,
  makeLocation,
  makePo,
  makeRequest,
  makeUser,
  resetDb,
  TEST_COMPANY,
} from './helpers/factory';

let userId: number;
let financeId: number;
let locationId: number;

beforeEach(async () => {
  await resetDb();
  userId = await makeUser({ displayName: 'ผู้ขอทดสอบ' });
  financeId = await makeUser({ displayName: 'บัญชีทดสอบ', roleName: 'FINANCE' });
  locationId = await makeLocation();
});

function register(requestId: number, grpoLineId: string, extra: Record<string, unknown> = {}) {
  return create(
    { requestId, grpoLineId, locationId, serialNumber: `SN-${Math.random()}`, ...extra } as never,
    userId,
  );
}

/** เดินทั้ง flow จนใบเป็น APPROVED (ขั้นที่บัญชีทำงาน) แล้วคืน id ของชิ้นที่ลงไว้ */
async function approved(poNumber: string, pieces = 2) {
  const chain = await makeApprovalChain();
  const po = await makePo(poNumber, [{ poLine: 1, quantity: pieces, unitPrice: 1_000 }], {
    ownerPrId: chain.ownerPrId,
  });
  const g = await makeGrpo(`GR-${poNumber}`, po.itemIds[0]!, pieces);
  const requestId = await makeRequest(poNumber, userId);
  const assetIds: number[] = [];
  for (let i = 0; i < pieces; i++) assetIds.push((await register(requestId, g.grpoLineId)).id);

  const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, requestId) });
  await submitRequest(requestId, row!.updatedAt, userId);
  await approveRequest(requestId, chain.managerUserId);
  return { ...chain, requestId, grpoLineId: g.grpoLineId, poItemId: po.itemIds[0]!, assetIds };
}

/**
 * ชื่อที่ backend จะโชว์สำหรับพนักงานคนหนึ่ง — ชื่อไทยจาก HR ไม่ใช่ displayName ของบัญชี
 * (ดู documentPersonName) เทียบกับค่าที่ factory สร้างจริง ไม่ hardcode ชื่อไว้ในเทสต์
 */
async function employeeNameOf(employeeId: number) {
  const e = await db.query.employee.findFirst({ where: eq(employee.id, employeeId) });
  return `${e!.firstName} ${e!.lastName}`;
}

/** ป้ายของชิ้นหนึ่งตามที่ backend คำนวณให้ — หน้าจอใช้ค่านี้ตรง ๆ */
async function badgeOf(requestId: number, assetId: number) {
  const slots = await findSlotsByRequest(requestId);
  const slot = slots.items
    .flatMap((i) => i.slots)
    .find((s) => s.status === 'registered' && s.assetId === assetId);
  return slot as Extract<typeof slot, { status: 'registered' }>;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('บัญชีตีกลับรายชิ้น (reject)', () => {
  test('ตีกลับแล้วชิ้นนั้นขึ้น rejected พร้อมเหตุผลและคนที่กด — ชิ้นอื่นในใบเดียวกันไม่กระทบ', async () => {
    const s = await approved('PO-R1');
    await rejectAsset(s.requestId, s.assetIds[0]!, 'S/N ไม่ตรงกับตัวเครื่อง', financeId, 'FINANCE');

    const bad = await badgeOf(s.requestId, s.assetIds[0]!);
    expect(bad.displayStatus).toBe('rejected');
    expect(bad.rejectReason).toBe('S/N ไม่ตรงกับตัวเครื่อง');
    expect(bad.rejectedByName).toBe('บัญชีทดสอบ');
    expect(bad.rejectedRole).toBe('FINANCE');

    // ★ ชิ้นที่เหลือต้องเดินหน้าต่อได้ — ถ้าดึงทั้งใบกลับเป็น REJECTED งานอีก 1 ชิ้นจะหยุดไปด้วย
    const good = await badgeOf(s.requestId, s.assetIds[1]!);
    expect(good.displayStatus).toBe('approved');
  });

  test('ชิ้นที่ถูกตีกลับอยู่ ออกเลขทับไม่ได้', async () => {
    const s = await approved('PO-R2');
    await rejectAsset(s.requestId, s.assetIds[0]!, 'รูปไม่ชัด', financeId, 'FINANCE');

    expect(
      assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-300', userId),
    ).rejects.toThrow(/ถูกตีกลับอยู่/);
  });

  test('★ ผู้ขอแก้ชิ้นที่ถูกตีกลับได้ ทั้งที่ใบเป็น APPROVED — และการแก้ล้างสถานะตีกลับให้เอง', async () => {
    const s = await approved('PO-R3');
    await rejectAsset(s.requestId, s.assetIds[0]!, 'S/N ผิด', financeId, 'FINANCE');

    await update(s.assetIds[0]!, { serialNumber: 'SN-ที่ถูกต้อง' }, userId);

    const fixed = await badgeOf(s.requestId, s.assetIds[0]!);
    expect(fixed.displayStatus).toBe('approved'); // กลับเข้าคิวบัญชีเอง ไม่ต้องกดปุ่มส่งกลับ
    expect(fixed.rejectReason).toBeNull();
    // แก้แล้วออกเลขได้ตามปกติ
    const numbered = await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-310', userId);
    expect(numbered.asset.lifecycle).toBe('REGISTERED');
  });

  test('ชิ้นที่ "ไม่ได้" ถูกตีกลับ ยังแก้ไม่ได้เมื่อใบอนุมัติแล้ว', async () => {
    // ปลดสิทธิ์แก้เฉพาะชิ้นที่ถูกตีกลับเท่านั้น ไม่ใช่ปลดทั้งใบ — ชิ้นอื่นบัญชีอาจกำลังออกเลขอยู่
    const s = await approved('PO-R4');
    await rejectAsset(s.requestId, s.assetIds[0]!, 'S/N ผิด', financeId, 'FINANCE');

    expect(update(s.assetIds[1]!, { serialNumber: 'SN-แอบแก้' }, userId)).rejects.toThrow(
      /เฉพาะชิ้นที่บัญชีตีกลับ/,
    );
  });

  // ★ ใบที่บัญชีตีกลับรายชิ้นยังเป็น APPROVED — ถ้าลิสต์ของผู้ขอกรองแค่ DRAFT/REJECTED
  // ใบจะหายไปจากสายตาคนที่ต้องแก้ วงจร "ตีกลับ → แก้ → กลับเข้าคิว" จะตันตรงกลาง
  // แล้วบัญชีกด Submit ไม่ได้ตลอดกาล (ชิ้นที่ตีกลับยังนับเป็นค้าง)
  test('ใบที่ถูกตีกลับรายชิ้นต้องโผล่ในลิสต์ของผู้ขอ พร้อมจำนวนชิ้นที่ยังไม่ได้แก้', async () => {
    const { getDraft, listMyDrafts } = await import(
      '@modules/business/asset-request/asset-request.service'
    );
    const s = await approved('PO-R6');
    await getDraft(s.requestId, userId); // ลงทะเบียนเป็นคนเปิดใบ (ลิสต์กรองด้วย opener)
    const query = { page: 1, limit: 10, status: ['DRAFT', 'REJECTED'] as string[] };

    // ยังไม่มีชิ้นไหนถูกตีกลับ = ใบ APPROVED ไม่ต้องโผล่
    const before = await listMyDrafts(userId, query as never);
    expect(before.data.find((d) => d.id === s.requestId)).toBeUndefined();

    await rejectAsset(s.requestId, s.assetIds[0]!, 'S/N ผิด', financeId, 'FINANCE');
    const after = await listMyDrafts(userId, query as never);
    const row = after.data.find((d) => d.id === s.requestId);
    expect(row).toBeDefined();
    expect((row as { rejectedAssetCount: number }).rejectedAssetCount).toBe(1);

    // แก้แล้ว (update ล้าง rejectedAt ให้เอง) = ไม่มีอะไรค้างฝั่งผู้ขอ ใบหลุดออกจากลิสต์
    await update(s.assetIds[0]!, { serialNumber: 'SN-แก้แล้ว' } as never, userId);
    const done = await listMyDrafts(userId, query as never);
    expect(done.data.find((d) => d.id === s.requestId)).toBeUndefined();
  });

  // ★ ป้าย "แก้ไขแล้ว" ของฝั่งบัญชี — ต้องมีคอลัมน์แยกเก็บ เพราะ update( {}, {}, {}) ล้าง rejectedAt ทิ้ง
  // ตอนผู้ขอแก้ ถ้าไม่เก็บไว้ บัญชีจะแยกไม่ออกว่าชิ้นไหนคือของที่เพิ่งแก้กลับมา
  test('แก้ชิ้นที่ถูกตีกลับ → ขึ้นป้าย "แก้ไขแล้ว" จนกว่าจะออกเลข', async () => {
    const s = await approved('PO-R7');
    expect((await badgeOf(s.requestId, s.assetIds[0]!)).rejectFixed).toBe(false);

    await rejectAsset(s.requestId, s.assetIds[0]!, 'รูปไม่ชัด', financeId, 'FINANCE');
    // ยังไม่ได้แก้ = ยังไม่ใช่ "แก้ไขแล้ว" (ป้ายที่ต้องขึ้นตอนนี้คือ rejected)
    expect((await badgeOf(s.requestId, s.assetIds[0]!)).rejectFixed).toBe(false);

    await update(s.assetIds[0]!, { serialNumber: 'SN-แก้แล้ว' } as never, userId);
    const fixed = await badgeOf(s.requestId, s.assetIds[0]!);
    expect(fixed.rejectFixed).toBe(true);
    expect(fixed.displayStatus).not.toBe('rejected'); // กลับเข้าคิวออกเลขแล้ว

    // ออกเลข = งานรอบนั้นจบ ป้ายต้องหายไป ไม่ค้างข้ามรอบ
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-330', userId);
    expect((await badgeOf(s.requestId, s.assetIds[0]!)).rejectFixed).toBe(false);
  });

  test('ตีกลับซ้ำหลังแก้ = ป้าย "แก้ไขแล้ว" หายไป (แก้มาแล้วแต่ยังไม่ผ่านอยู่ดี)', async () => {
    const s = await approved('PO-R8');
    await rejectAsset(s.requestId, s.assetIds[0]!, 'รอบแรก', financeId, 'FINANCE');
    await update(s.assetIds[0]!, { serialNumber: 'SN-รอบสอง' } as never, userId);
    expect((await badgeOf(s.requestId, s.assetIds[0]!)).rejectFixed).toBe(true);

    await rejectAsset(s.requestId, s.assetIds[0]!, 'ยังไม่ถูก', financeId, 'FINANCE');
    const again = await badgeOf(s.requestId, s.assetIds[0]!);
    expect(again.rejectFixed).toBe(false);
    expect(again.displayStatus).toBe('rejected');

    // ★ วนได้ไม่จำกัดรอบ: rejectFixedAt เป็นธงของ "รอบปัจจุบัน" ไม่ใช่ "เคยแก้มาแล้วครั้งหนึ่ง"
    //   ถ้าเปลี่ยนเป็นธงถาวร (ตั้งครั้งเดียวไม่ล้าง) รอบ 2 ขึ้นไปจะแยกไม่ออกว่าชิ้นนี้แก้มาแล้ว
    //   หรือยัง — บัญชีต้องนั่งเทียบเองว่าข้อมูลเปลี่ยนจากที่ตีกลับไปหรือเปล่า
    await update(s.assetIds[0]!, { serialNumber: 'SN-รอบสาม' } as never, userId);
    const fixedAgain = await badgeOf(s.requestId, s.assetIds[0]!);
    expect(fixedAgain.rejectFixed).toBe(true);
    expect(fixedAgain.displayStatus).not.toBe('rejected');
  });

  // ★ ตัวเลขที่หน้าคิวของบัญชีใช้ขึ้นจุดแดงบนปุ่ม — ต้องเดินตามธงรายชิ้นทุกรอบ
  //   ถ้าค้างไม่ลด บัญชีจะเห็นจุดแดงบนใบที่ไม่มีอะไรค้าง แล้วเลิกเชื่อจุดนั้นไปเลย
  //   ซึ่งแย่กว่าไม่มีจุด เพราะใบที่มีของค้างจริงจะถูกมองข้ามไปด้วย
  test('fixedAssets ของหน้าคิว = จำนวนชิ้นที่รอบัญชีตรวจซ้ำ ขึ้น-ลงตามรอบ', async () => {
    const s = await approved('PO-R9');
    const countOf = async () => (await getPendingRegistration(s.requestId)).fixedAssets;

    expect(await countOf()).toBe(0);

    await rejectAsset(s.requestId, s.assetIds[0]!, 'รอบแรก', financeId, 'FINANCE');
    expect(await countOf()).toBe(0); // ยังรอผู้ขอ ไม่ใช่รอบัญชี

    await update(s.assetIds[0]!, { serialNumber: 'SN-แก้1' } as never, userId);
    expect(await countOf()).toBe(1);

    // ตีกลับรอบสอง = กลับไปรอผู้ขอ จุดต้องหาย
    await rejectAsset(s.requestId, s.assetIds[0]!, 'ยังไม่ถูก', financeId, 'FINANCE');
    expect(await countOf()).toBe(0);

    await update(s.assetIds[0]!, { serialNumber: 'SN-แก้2' } as never, userId);
    expect(await countOf()).toBe(1);

    // ออกเลข = จบงานชิ้นนั้น จุดต้องหายถาวร
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-331', financeId);
    expect(await countOf()).toBe(0);
  });

  test('cancel ก็ดับจุดแดงเหมือนออกเลข — ปิดถาวรแล้วไม่มีใครต้องตรวจชิ้นนั้นอีก', async () => {
    const s = await approved('PO-R10');
    await rejectAsset(s.requestId, s.assetIds[0]!, 'รูปไม่ชัด', financeId, 'FINANCE');
    await update(s.assetIds[0]!, { serialNumber: 'SN-แก้แล้ว' } as never, userId);
    expect((await getPendingRegistration(s.requestId)).fixedAssets).toBe(1);

    await cancelAsset(s.requestId, s.assetIds[0]!, 'ของส่งคืน', financeId);
    expect((await getPendingRegistration(s.requestId)).fixedAssets).toBe(0);
  });

  test('ตีกลับซ้ำไม่ได้', async () => {
    const s = await approved('PO-R5');
    await rejectAsset(s.requestId, s.assetIds[0]!, 'ครั้งแรก', financeId, 'FINANCE');
    expect(
      rejectAsset(s.requestId, s.assetIds[0]!, 'ครั้งที่สอง', financeId, 'FINANCE'),
    ).rejects.toThrow(/ถูกตีกลับอยู่แล้ว/);
  });

  // ★ ชิ้นที่ออกเลขไปแล้วยังถอยกลับได้ ตราบใดที่ยังไม่ได้กด Submit แจ้งผลกลับผู้ขอ
  // (เส้นตายเดียวกับการแก้เลข) — เลขที่กรอกไว้ต้องถูกล้างทิ้งด้วย ไม่งั้นชิ้น DRAFT จะค้างเลข
  // ที่จองไว้ในดัชนี unique และตัวนับ "เหลือกี่ชิ้นที่ยังไม่มีเลข" จะขัดกับหน้าจอ
  test('ตีกลับชิ้นที่ออกเลขแล้วได้ก่อน Submit — เลขถูกล้าง กลับเป็น DRAFT', async () => {
    const s = await approved('PO-R5B');
    await assignAssetNumber(s.requestId, s.assetIds[1]!, 'COM-775-26-320', userId);

    await rejectAsset(s.requestId, s.assetIds[1]!, 'เลขผิด กรอกใหม่', financeId, 'FINANCE');
    const row = await db.query.asset.findFirst({ where: eq(asset.id, s.assetIds[1]!) });
    expect(row!.lifecycle).toBe('DRAFT');
    expect(row!.assetNumber).toBeNull();
    expect(row!.rejectReason).toBe('เลขผิด กรอกใหม่');

    // เลขที่ถูกล้างต้องเอากลับมาใช้กับชิ้นอื่นได้ทันที (ไม่ค้างจองในดัชนี unique)
    const reused = await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-320', userId);
    expect(reused.asset.assetNumber).toBe('COM-775-26-320');
  });

  test('★ ชิ้นที่ถูกตีกลับไม่บล็อกปุ่มยืนยันอีกแล้ว — กดได้แล้วออกมาเป็นผลลัพธ์ REJECTED (0018)', async () => {
    // กติกาเดิม (นับ DRAFT ทั้งหมดเป็น "ค้าง") ทำให้ใบที่มีชิ้นตีกลับกดปุ่มไม่ได้ตลอดกาล
    // ซึ่งแปลว่าการแจ้ง "มีรายการต้องแก้" ไปไม่ถึงผู้ขอเลย — ตอนนี้ด่านคือ "บัญชีตัดสินครบ"
    // ชิ้นที่ตีกลับถือว่าตัดสินแล้ว (รอผู้ขอ ไม่ได้รอบัญชี)
    const { confirmRegistration } = await import(
      '@modules/business/asset-request/asset-request.service'
    );
    const s = await approved('PO-R7');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-330', userId);
    await rejectAsset(s.requestId, s.assetIds[1]!, 'S/N ผิด', financeId, 'FINANCE');

    holdRegistration(s.requestId, financeId);
    const result = await confirmRegistration(s.requestId, financeId);
    expect(result.outcome).toBe('REJECTED');
    expect(result.rejectedCount).toBe(1);

    // ★ ใบต้องยังอยู่ในคิวบัญชี — ถ้าไปเซ็ต completeNotifiedAt ใบจะหลุดจากคิวทั้งที่งานไม่จบ
    // แล้วพอผู้ขอแก้เสร็จก็ไม่มีใครออกเลขให้ได้อีก (ทุกปุ่มของบัญชีตอบ 409)
    const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, s.requestId) });
    expect(row!.completeNotifiedAt).toBeNull();
    expect(row!.rejectNotifiedAt).not.toBeNull();
  });

  test('ยังมีชิ้นที่บัญชีไม่ได้แตะเลย = ยังกดยืนยันไม่ได้', async () => {
    // ด่านไม่ได้หายไป แค่เปลี่ยนนิยาม — ชิ้นที่ยังไม่ถูกตัดสินยังบล็อกอยู่เหมือนเดิม
    const { confirmRegistration } = await import(
      '@modules/business/asset-request/asset-request.service'
    );
    const s = await approved('PO-R8');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-331', userId);

    holdRegistration(s.requestId, financeId);
    await expect(confirmRegistration(s.requestId, financeId)).rejects.toThrow(/เหลืออีก 1 ชิ้น/);
  });

  test('แจ้งตีกลับแล้วกดซ้ำทั้งที่ไม่มีอะไรเปลี่ยน = ไม่ยิงเมลซ้ำ', async () => {
    const { confirmRegistration } = await import(
      '@modules/business/asset-request/asset-request.service'
    );
    const s = await approved('PO-R9');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-332', userId);
    await rejectAsset(s.requestId, s.assetIds[1]!, 'รูปไม่ชัด', financeId, 'FINANCE');

    holdRegistration(s.requestId, financeId);
    await confirmRegistration(s.requestId, financeId);

    holdRegistration(s.requestId, financeId);
    await expect(confirmRegistration(s.requestId, financeId)).rejects.toThrow(
      /ยังไม่มีอะไรเปลี่ยนตั้งแต่รอบก่อน/,
    );

    // ผู้ขอแก้แล้ว = มีอะไรเปลี่ยน กดแจ้งรอบใหม่ได้ (รอบนี้ทุกชิ้นพร้อมออกเลข)
    await update(s.assetIds[1]!, { serialNumber: 'SN-แก้แล้ว' }, userId);
    await assignAssetNumber(s.requestId, s.assetIds[1]!, 'COM-775-26-333', userId);
    holdRegistration(s.requestId, financeId);
    const done = await confirmRegistration(s.requestId, financeId);
    expect(done.outcome).toBe('COMPLETE');
  });

  test('ใบที่ยังไม่อนุมัติ ตีกลับรายชิ้นไม่ได้ (ผู้ขอแก้เองได้อยู่แล้ว)', async () => {
    const chain = await makeApprovalChain();
    const po = await makePo('PO-R6', [{ poLine: 1, quantity: 1, unitPrice: 100 }], {
      ownerPrId: chain.ownerPrId,
    });
    const g = await makeGrpo('GR-R6', po.itemIds[0]!, 1);
    const requestId = await makeRequest('PO-R6', userId);
    const a = await register(requestId, g.grpoLineId);

    expect(rejectAsset(requestId, a.id, 'เร็วไป', financeId, 'FINANCE')).rejects.toThrow(
      /เฉพาะคำขอที่อนุมัติแล้ว/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('บัญชีปิดถาวร (cancel)', () => {
  test('ปิดถาวรแล้วขึ้น cancelled พร้อมเหตุผล และแก้ไขไม่ได้อีก', async () => {
    const s = await approved('PO-C1');
    await cancelAsset(s.requestId, s.assetIds[0]!, 'ส่งคืนผู้ขาย', financeId);

    const dead = await badgeOf(s.requestId, s.assetIds[0]!);
    expect(dead.displayStatus).toBe('cancelled');
    expect(dead.cancelReason).toBe('ส่งคืนผู้ขาย');
    expect(dead.cancelledByName).toBe('บัญชีทดสอบ');

    expect(update(s.assetIds[0]!, { serialNumber: 'SN-ใหม่' }, userId)).rejects.toThrow(
      /ถูกปิดถาวรแล้ว/,
    );
  });

  test('ปิดถาวรทับชิ้นที่ตีกลับไว้ได้ และร่องรอยการตีกลับต้องถูกล้าง', async () => {
    // ck_asset_reject_only_draft บังคับว่า rejectedAt มีได้เฉพาะตอน lifecycle = DRAFT
    // ถ้า cancelAsset ไม่ล้างให้ update ทั้งก้อนจะโดน constraint ปฏิเสธ = ยกเลิกไม่ได้เลย
    const s = await approved('PO-C2');
    await rejectAsset(s.requestId, s.assetIds[0]!, 'S/N ผิด', financeId, 'FINANCE');
    await cancelAsset(s.requestId, s.assetIds[0]!, 'สุดท้ายส่งคืนเลย', financeId);

    const dead = await badgeOf(s.requestId, s.assetIds[0]!);
    expect(dead.displayStatus).toBe('cancelled');
    expect(dead.rejectReason).toBeNull();

    const row = await db.query.asset.findFirst({ where: eq(asset.id, s.assetIds[0]!) });
    expect(row!.rejectedAt).toBeNull();
    expect(row!.rejectedBy).toBeNull();
  });

  test('ปลดการปิด (uncancel) แล้วกลับมาเป็น DRAFT และแก้ต่อได้', async () => {
    const s = await approved('PO-C3');
    await cancelAsset(s.requestId, s.assetIds[0]!, 'กดผิด', financeId);
    await uncancelAsset(s.requestId, s.assetIds[0]!, financeId);

    const back = await badgeOf(s.requestId, s.assetIds[0]!);
    expect(back.displayStatus).toBe('approved');
    expect(back.cancelReason).toBeNull();
  });

  test('ปลดการปิดของชิ้นที่ไม่ได้ถูกปิด ทำไม่ได้', async () => {
    const s = await approved('PO-C4');
    expect(uncancelAsset(s.requestId, s.assetIds[0]!, financeId)).rejects.toThrow(
      /ไม่ได้ถูกปิดถาวรอยู่/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ป้ายสถานะต้องอ่านจากใบเจ้าของชิ้น ไม่ใช่ใบที่กำลังเปิดดู', () => {
  test('★ เปิดใบรอบใหม่ของ PO เดิม — ชิ้นที่อนุมัติไปแล้วต้องยังขึ้น approved ไม่ใช่ saved', async () => {
    // บั๊กที่ผู้ใช้เจอ: findSlotsByRequest นับข้ามใบ ชิ้นของใบก่อนจึงติดมาในรายการของใบใหม่
    // ป้ายเดิมตีตราทุกชิ้นด้วยสถานะของ "ใบที่เปิดดู" (DRAFT) ชิ้นที่ approved ไปแล้วเลยขึ้น Saved
    const s = await approved('PO-V1', 2);
    await makeGrpo('GR-รอบสอง', s.poItemId, 2); // ของล็อตใหม่มาถึง
    const reqB = await makeRequest('PO-V1', userId); // เปิดใบใหม่ (ใบเก่า APPROVED = terminal)

    const slots = await findSlotsByRequest(reqB);
    expect(slots.status).toBe('DRAFT'); // ใบที่เปิดดูเป็น DRAFT

    const fromOldRequest = slots.items[0]!.slots.filter(
      (x) => x.status === 'registered' && x.requestId === s.requestId,
    );
    expect(fromOldRequest).toHaveLength(2);
    for (const x of fromOldRequest) {
      expect((x as { displayStatus: string }).displayStatus).toBe('approved');
    }
  });

  test('ป้ายไล่ตาม flow ครบทุกขั้น', async () => {
    const chain = await makeApprovalChain();
    const po = await makePo('PO-V2', [{ poLine: 1, quantity: 2, unitPrice: 100 }], {
      ownerPrId: chain.ownerPrId,
    });
    // รับมาแค่ 1 ชิ้นจาก 2 ที่สั่ง — ช่องที่สองจึงยังไม่มี GRPO รองรับ
    const g = await makeGrpo('GR-V2', po.itemIds[0]!, 1);
    const requestId = await makeRequest('PO-V2', userId);

    const before = await findSlotsByRequest(requestId);
    expect(before.items[0]!.slots.map((x) => x.displayStatus)).toEqual([
      'pendingCreation',
      'noGrpo',
    ]);

    const a = await register(requestId, g.grpoLineId);
    expect((await badgeOf(requestId, a.id)).displayStatus).toBe('saved');

    const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, requestId) });
    await submitRequest(requestId, row!.updatedAt, userId);
    expect((await badgeOf(requestId, a.id)).displayStatus).toBe('pendingManager');

    await approveRequest(requestId, chain.managerUserId);
    const afterApprove = await badgeOf(requestId, a.id);
    expect(afterApprove.displayStatus).toBe('approved');
    expect(afterApprove.approvedByName).toBe(await employeeNameOf(chain.managerEmployeeId));

    await assignAssetNumber(requestId, a.id, 'COM-775-26-400', userId);
    const done = await badgeOf(requestId, a.id);
    expect(done.displayStatus).toBe('registered');
    expect(done.assetNumber).toBe('COM-775-26-400');
  });

  test('หัวหน้าตีกลับทั้งใบ — ทุกชิ้นในใบขึ้น rejected พร้อมบอกว่ามาจาก MANAGER', async () => {
    const chain = await makeApprovalChain();
    const po = await makePo('PO-V3', [{ poLine: 1, quantity: 2, unitPrice: 100 }], {
      ownerPrId: chain.ownerPrId,
    });
    const g = await makeGrpo('GR-V3', po.itemIds[0]!, 2);
    const requestId = await makeRequest('PO-V3', userId);
    const a1 = await register(requestId, g.grpoLineId);
    await register(requestId, g.grpoLineId);

    const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, requestId) });
    await submitRequest(requestId, row!.updatedAt, userId);
    const { rejectRequest } = await import('@modules/business/asset-request/asset-request.service');
    await rejectRequest(requestId, chain.managerUserId, 'งบไม่พอรอบนี้', 'MANAGER');

    const bad = await badgeOf(requestId, a1.id);
    expect(bad.displayStatus).toBe('rejected');
    expect(bad.rejectReason).toBe('งบไม่พอรอบนี้');
    expect(bad.rejectedRole).toBe('MANAGER');
    expect(bad.rejectedByName).toBe(await employeeNameOf(chain.managerEmployeeId));

    // ★ ตีกลับแล้วต้องแก้ได้จริง — เคยพังตรงนี้ (update( {}, {}, {}) ยอมเฉพาะใบ DRAFT)
    await update(a1.id, { serialNumber: 'SN-แก้แล้ว' }, userId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// บั๊กที่ยังไม่ได้แก้ — เขียนผลลัพธ์ที่ถูกต้องไว้แล้วทำเครื่องหมาย test.failing
// พอแก้แล้ว bun จะรายงานว่า "ผ่านทั้งที่บอกว่าจะล้ม" ให้ลบ .failing ตอนนั้น
describe('บั๊กค้าง — ตัวนับใน assertSubmittable ยังนับชิ้นที่ปิดถาวรแล้ว', () => {
  test.failing('ใบที่ทุกชิ้นถูกปิดถาวรแล้ว ต้องส่งขออนุมัติไม่ได้', async () => {
    const chain = await makeApprovalChain();
    const po = await makePo('PO-BUG4', [{ poLine: 1, quantity: 2, unitPrice: 100 }], {
      ownerPrId: chain.ownerPrId,
    });
    const g = await makeGrpo('GR-1', po.itemIds[0]!, 2);
    const requestId = await makeRequest('PO-BUG4', userId);
    const a1 = await register(requestId, g.grpoLineId);
    await cancelAsset(requestId, a1.id, 'ส่งคืนทั้งหมด', financeId);

    const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, requestId) });
    expect(submitRequest(requestId, row!.updatedAt, userId)).rejects.toThrow(
      /ยังไม่มีรายการสินทรัพย์/,
    );
  });

});

// เคยเป็น test.failing ในกลุ่ม "บั๊กค้าง" ข้างบน — หายไปเองตอนตัดด่านบังคับ Serial number
// ออกจาก assertSubmittable (S/N ไม่ใช่ช่องบังคับแล้ว) ไม่ได้แก้ที่ตัวนับ
//
// เก็บเทสต์ไว้เพราะมันเฝ้าอีกเรื่องหนึ่งที่ยังสำคัญ: ชิ้นที่ถูกปิดถาวรต้องไม่ไปขวางการส่งใบ
// ของชิ้นที่เหลือ ไม่ว่าด่านตรวจในอนาคตจะเป็นอะไรก็ตาม
test('ชิ้นที่ปิดถาวรแล้วไม่ขวางการส่งใบ (ถึงจะไม่มี Serial number)', async () => {
  const chain = await makeApprovalChain();
  const po = await makePo('PO-BUG5', [{ poLine: 1, quantity: 2, unitPrice: 100 }], {
    ownerPrId: chain.ownerPrId,
  });
  const g = await makeGrpo('GR-1', po.itemIds[0]!, 2);
  const requestId = await makeRequest('PO-BUG5', userId);
  const bad = await register(requestId, g.grpoLineId, { serialNumber: '' });
  await register(requestId, g.grpoLineId);
  await cancelAsset(requestId, bad.id, 'ของผิดรุ่น ส่งคืน', financeId);

  const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, requestId) });
  const result = await submitRequest(requestId, row!.updatedAt, userId);
  expect(result.status).toBe('PENDING_APPROVAL');
});

// ─────────────────────────────────────────────────────────────────────────────
// ═══ QR ของสติกเกอร์ — ผูกกับ "เลขสินทรัพย์" ไม่ใช่กับตัวชิ้น ═══
//
// กติกาเดียว: มีเลข = มี QR / ไม่มีเลข = ไม่มี QR
// ถ้าสองอย่างนี้หลุดจากกันเมื่อไหร่ สติกเกอร์บนตัวเครื่องจะชี้ไปที่เลขที่ไม่ใช่ของมัน
// ซึ่งเป็นอาการที่ไม่มีใครเห็นจนกว่าจะมีคนเดินไปสแกนของจริงในรอบตรวจนับ
describe('QR ของสติกเกอร์', () => {
  test('ออกเลข = ได้ QR ที่ชี้ไปที่เลขนั้น', async () => {
    const s = await approved('PO-QR1');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-400', financeId);

    const row = await db.query.asset.findFirst({ where: eq(asset.id, s.assetIds[0]!) });
    expect(row!.qrCode).toBe(assetQrUrl(TEST_COMPANY, 'COM-775-26-400'));
    expect(row!.qrCode).toContain('COM-775-26-400');
  });

  test('ตีกลับ = เลขหาย QR ต้องหายตามไปด้วย', async () => {
    const s = await approved('PO-QR2');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-401', financeId);
    await rejectAsset(s.requestId, s.assetIds[0]!, 'S/N ไม่ตรง', financeId, 'FINANCE');

    const row = await db.query.asset.findFirst({ where: eq(asset.id, s.assetIds[0]!) });
    expect(row!.assetNumber).toBeNull();
    expect(row!.qrCode).toBeNull();
  });

  test('QR ที่ถูกล้างแล้วต้องไม่จองค่าไว้ — ชิ้นอื่นเอาเลขเดิมไปใช้ได้', async () => {
    // uq_asset_qr_code เป็น unique ในแถวที่ยังไม่ลบ ถ้าตีกลับแล้วไม่ล้าง QR ชิ้นที่รับเลข
    // เดิมไปใช้ต่อจะออกเลขไม่ได้ ทั้งที่เลขนั้นถูกคืนเข้าระบบแล้ว
    const s = await approved('PO-QR3');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-402', financeId);
    await rejectAsset(s.requestId, s.assetIds[0]!, 'ของผิดตัว', financeId, 'FINANCE');

    const moved = await assignAssetNumber(s.requestId, s.assetIds[1]!, 'COM-775-26-402', financeId);
    expect(moved.asset.assetNumber).toBe('COM-775-26-402');
    const row = await db.query.asset.findFirst({ where: eq(asset.id, s.assetIds[1]!) });
    expect(row!.qrCode).toBe(assetQrUrl(TEST_COMPANY, 'COM-775-26-402'));
  });

  test('แก้เลขทับของเดิม = QR ตามไปที่เลขใหม่ ไม่ค้างของเก่า', async () => {
    const s = await approved('PO-QR4');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-403', financeId);
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-404', financeId);

    const row = await db.query.asset.findFirst({ where: eq(asset.id, s.assetIds[0]!) });
    expect(row!.qrCode).toBe(assetQrUrl(TEST_COMPANY, 'COM-775-26-404'));
  });

  test('ปิดถาวรแล้วปลดคืน = QR อยู่ครบ (เลขไม่ได้ถูกล้าง ต่างจากตีกลับ)', async () => {
    const s = await approved('PO-QR5');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-405', financeId);
    await cancelAsset(s.requestId, s.assetIds[0]!, 'ส่งคืนผู้ขาย', financeId);

    const cancelled = await db.query.asset.findFirst({ where: eq(asset.id, s.assetIds[0]!) });
    expect(cancelled!.qrCode).toBe(assetQrUrl(TEST_COMPANY, 'COM-775-26-405'));

    await uncancelAsset(s.requestId, s.assetIds[0]!, financeId);
    const back = await db.query.asset.findFirst({ where: eq(asset.id, s.assetIds[0]!) });
    expect(back!.lifecycle).toBe('REGISTERED');
    expect(back!.qrCode).toBe(assetQrUrl(TEST_COMPANY, 'COM-775-26-405'));
  });
})
