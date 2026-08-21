// ═══ วงจรสถานะของใบคำขอ (และของชิ้น) ═══
//
//   DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED ──ออกเลขรายชิ้น──▶ (แจ้งผลกลับ)
//     ▲                      │
//     └────── reject ────────┘  (REJECTED = แก้แล้วส่งใหม่ได้ เหมือน DRAFT)
//
// สามแกนที่ห้ามปนกัน (ดูคอมเมนต์หัวไฟล์ asset-request.ts):
//   ใบ  = asset_request.status   ชิ้น = asset.lifecycle   PO = purchase_order.docStatus
// เทสต์ชุดนี้กันไม่ให้ใครเผลอเอาสามอย่างนี้มาผูกกันใหม่ และกันไม่ให้ "ทางลัด" ที่ข้ามด่าน
// กลับเข้ามาเงียบ ๆ — ทุกด่านที่หายไปแปลว่าใบค้างในสถานะที่ไม่มีใครกู้ได้
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { asset, assetRequest, employee, user } from '@intrastucture/db/schema';
import { create, findSlotsByRequest } from '@modules/business/asset/asset.service';
import {
  approveRequest,
  createDraft,
  getPendingRegistration,
  listPendingRegistration,
  rejectRequest,
  submitRequest,
} from '@modules/business/asset-request/asset-request.service';
// ปุ่มของบัญชีผ่าน helper ที่หยิบ lock ขั้นบัญชีให้ก่อน — ไฟล์นี้ทดสอบวงจรสถานะ ไม่ใช่กติกา lock
import {
  assignAssetNumber,
  cancelAsset,
  confirmRegistration,
  uncancelAsset,
} from './helpers/registrar';
import {
  makeApprovalChain,
  makeEmployee,
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

function register(requestId: number, grpoLineId: string, extra: Record<string, unknown> = {}) {
  return create(
    { requestId, grpoLineId, locationId, serialNumber: `SN-${Math.random()}`, ...extra } as never,
    userId,
  );
}

async function updatedAtOf(requestId: number) {
  const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, requestId) });
  return row!.updatedAt;
}

async function statusOf(requestId: number) {
  const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, requestId) });
  return row!.status;
}

/** PO + GRPO + ใบ DRAFT + หัวหน้าครบสาย พร้อมให้ submit ได้ทันที */
async function scenario(poNumber: string, opts: { managerEmail?: string | null } = {}) {
  const chain = await makeApprovalChain(opts);
  const po = await makePo(poNumber, [{ poLine: 1, quantity: 2, unitPrice: 1_000 }], {
    ownerPrId: chain.ownerPrId,
  });
  const g = await makeGrpo(`GR-${poNumber}`, po.itemIds[0]!, 2);
  const requestId = await makeRequest(poNumber, userId);
  return { ...chain, poItemId: po.itemIds[0]!, grpoLineId: g.grpoLineId, requestId };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('เปิดใบ (createDraft)', () => {
  test('PO ที่ไม่มีในระบบ = 404 ไม่ใช่เปิดใบเปล่าทิ้งไว้', async () => {
    expect(createDraft('PO-ไม่มีจริง', userId)).rejects.toThrow(/Purchase order/);
  });

  test('PO เดิมที่ยังมีใบเปิดค้างอยู่ = ใช้ใบเดิม ไม่เปิดใบที่สอง', async () => {
    await makePo('PO-S1', [{ poLine: 1, quantity: 1, unitPrice: 100 }]);
    const first = await createDraft('PO-S1', userId);
    const second = await createDraft('PO-S1', await makeUser());

    expect(second.reused).toBe(true);
    expect(second.requestId).toBe(first.requestId);
  });

  test('★ ใบที่กำลังรออนุมัติอยู่ = เปิดใบที่สองบน PO เดิมไม่ได้ (กันใบซ้อนตอนถูกตีกลับ)', async () => {
    // เคสที่ต้องกัน: ใบ A ส่งไปรออนุมัติ → คนอื่นเปิด PO เดิมได้ใบ B → หัวหน้าตีกลับใบ A
    // จะเหลือใบที่แก้ได้สองใบบน PO เดียวกัน แย่งช่อง/แย่ง unitNo กัน และเหตุผลตีกลับของ A
    // ถูกทิ้งไว้ในใบที่ไม่มีใครเปิด
    //
    // ทางกันอยู่ที่ uq_asset_request_open_round (unique poNumber where status IN
    // DRAFT/PENDING_APPROVAL/REJECTED) + createDraft ที่คืนใบเดิมแทนการสร้างใหม่
    const s = await scenario('PO-S3');
    await register(s.requestId, s.grpoLineId);
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);

    const another = await createDraft('PO-S3', await makeUser());
    expect(another.reused).toBe(true);
    expect(another.requestId).toBe(s.requestId); // ได้ใบเดิมที่รออนุมัติอยู่ ไม่ใช่ใบใหม่

    // ตีกลับแล้วก็ยังมีใบเดียว และเป็นใบที่ถือเหตุผลตีกลับอยู่
    await rejectRequest(s.requestId, s.managerUserId, 'ของไม่ตรงสเปก', 'MANAGER');
    const openRounds = await db.query.assetRequest.findMany({
      where: eq(assetRequest.poNumber, 'PO-S3'),
    });
    expect(openRounds).toHaveLength(1);
    expect(openRounds[0]!.rejectReason).toBe('ของไม่ตรงสเปก');
  });

  test('ใบที่ถูกตีกลับยังล็อก PO อยู่ — ต้องแก้ใบเดิม ไม่ใช่เปิดใบใหม่ทับ', async () => {
    const s = await scenario('PO-S4');
    await register(s.requestId, s.grpoLineId);
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);
    await rejectRequest(s.requestId, s.managerUserId, 'แก้ราคาก่อน', 'MANAGER');

    const another = await createDraft('PO-S4', userId);
    expect(another.requestId).toBe(s.requestId);
    expect(another.reused).toBe(true);
  });

  test('ใบก่อนหน้าปิดที่ APPROVED แล้ว = เปิดใบใหม่ของ PO เดิมได้ (ของล็อตถัดไป)', async () => {
    await makePo('PO-S2', [{ poLine: 1, quantity: 1, unitPrice: 100 }]);
    const first = await createDraft('PO-S2', userId);
    await setRequestStatus(first.requestId, 'APPROVED');

    const second = await createDraft('PO-S2', userId);
    expect(second.reused).toBe(false);
    expect(second.requestId).not.toBe(first.requestId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ส่งคำขอ (submit) — ด่านตรวจเนื้อหา', () => {
  test('ใบเปล่าส่งไม่ได้', async () => {
    const s = await scenario('PO-T1');
    expect(submitRequest(s.requestId, await updatedAtOf(s.requestId), userId)).rejects.toThrow(
      /ยังไม่มีรายการสินทรัพย์/,
    );
  });

  // ★ Serial number ไม่บังคับ — สินทรัพย์จำนวนมากไม่มีเลขเครื่องเลย (โต๊ะ เก้าอี้ ตู้ งานติดตั้ง)
  //   คอลัมน์เป็น nullable ทั้งที่ DB / createAssetBody / ฟอร์มหน้าเว็บ ด่าน submit เคยเป็น
  //   ที่เดียวที่ยังบังคับ ทำให้ของกลุ่มนั้นส่งใบไม่ได้เลย
  //
  //   เทสต์นี้เฝ้าไม่ให้ใครเผลอใส่ด่านกลับมา — ถ้าวันหลังต้องบังคับจริง ให้บังคับ "ตามหมวด"
  //   ไม่ใช่ทั้งระบบ (ดูคอมเมนต์ที่ assertSubmittable)
  test('ชิ้นที่ไม่มี Serial number ส่งได้ตามปกติ — S/N ไม่ใช่ช่องบังคับ', async () => {
    const s = await scenario('PO-T2');
    await register(s.requestId, s.grpoLineId, { serialNumber: '   ' }); // ช่องว่าง = ไม่ได้กรอก
    await register(s.requestId, s.grpoLineId); // ไม่ส่ง key มาเลย

    const res = await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);
    expect(res.status).toBe('PENDING_APPROVAL');
  });

  test('ไม่มีชิ้นเลยยังส่งไม่ได้ — ด่านที่เหลืออยู่ในระดับชิ้น', async () => {
    const s = await scenario('PO-T2B');
    expect(submitRequest(s.requestId, await updatedAtOf(s.requestId), userId)).rejects.toThrow(
      /ยังไม่มีรายการสินทรัพย์/,
    );
  });

  test('ราคารวมของบรรทัดเกินยอดใน PO ส่งไม่ได้', async () => {
    const s = await scenario('PO-T3');
    await register(s.requestId, s.grpoLineId, { acquisitionCost: 1_500 });
    await register(s.requestId, s.grpoLineId, { acquisitionCost: 1_500 }); // รวม 3,000 > lineTotal 2,000
    expect(submitRequest(s.requestId, await updatedAtOf(s.requestId), userId)).rejects.toThrow(
      /เกินยอดใน PO/,
    );
  });

  test('★ ราคาต้องรวม "ทุกใบ" ของ PO เดียวกัน ไม่ใช่เฉพาะใบตัวเอง', async () => {
    // บั๊กเงียบที่สุดในกลุ่มนี้: รอบ 1 ลง 1,200 / รอบ 2 ลง 1,200 บน lineTotal 2,000
    // ถ้านับแค่ใบตัวเอง ทั้งสองใบผ่านหมด แล้วยอดจริง 2,400 ทะลุ PO โดยไม่มีอะไรฟ้อง
    const s = await scenario('PO-T4');
    await register(s.requestId, s.grpoLineId, { acquisitionCost: 1_200 });
    await setRequestStatus(s.requestId, 'APPROVED'); // ใบรอบก่อนปิดไปแล้ว

    const req2 = await makeRequest('PO-T4', userId);
    await register(req2, s.grpoLineId, { acquisitionCost: 1_200 });

    expect(submitRequest(req2, await updatedAtOf(req2), userId)).rejects.toThrow(/เกินยอดใน PO/);
  });

  test('ของที่ถูกตัดทิ้ง (CANCELLED) ต้องไม่กินโควตาราคาของรอบถัดไป', async () => {
    const s = await scenario('PO-T5');
    const a1 = await register(s.requestId, s.grpoLineId, { acquisitionCost: 1_200 });
    await cancelAsset(s.requestId, a1.id, 'ส่งคืนผู้ขาย', userId);
    await setRequestStatus(s.requestId, 'APPROVED');

    const req2 = await makeRequest('PO-T5', userId);
    await register(req2, s.grpoLineId, { acquisitionCost: 1_200 });

    const result = await submitRequest(req2, await updatedAtOf(req2), userId);
    expect(result.status).toBe('PENDING_APPROVAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ส่งคำขอ (submit) — ด่านหาผู้อนุมัติ ต้องอยู่ "ก่อน" เปลี่ยนสถานะ', () => {
  test('หัวหน้าไม่มีอีเมล = ไม่ส่ง และใบต้องยังเป็น DRAFT ให้แก้แล้วส่งใหม่ได้', async () => {
    const s = await scenario('PO-U1', { managerEmail: null });
    await register(s.requestId, s.grpoLineId);

    expect(submitRequest(s.requestId, await updatedAtOf(s.requestId), userId)).rejects.toThrow(
      /ยังไม่มีอีเมล/,
    );
    // ★ หัวใจของด่านนี้: ล้มแล้วต้องไม่ทิ้งใบไว้ที่ PENDING_APPROVAL ซึ่งส่งซ้ำไม่ได้อีกเลย
    expect(await statusOf(s.requestId)).toBe('DRAFT');
  });

  test('PO ไม่มีผู้ขอซื้อ (OwnerPR) = หาหัวหน้าไม่ได้ ใบยังเป็น DRAFT', async () => {
    const po = await makePo('PO-U2', [{ poLine: 1, quantity: 1, unitPrice: 100 }]); // ไม่ผูก ownerPrId
    const g = await makeGrpo('GR-U2', po.itemIds[0]!, 1);
    const requestId = await makeRequest('PO-U2', userId);
    await register(requestId, g.grpoLineId);

    expect(submitRequest(requestId, await updatedAtOf(requestId), userId)).rejects.toThrow(
      /ไม่มีข้อมูลผู้ขอซื้อ/,
    );
    expect(await statusOf(requestId)).toBe('DRAFT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('submit → approve → reject', () => {
  test('เส้นทางปกติ: DRAFT → PENDING_APPROVAL พร้อมบันทึกคนกดส่งและหัวหน้าที่ถูกส่งไปหา', async () => {
    const s = await scenario('PO-V1');
    await register(s.requestId, s.grpoLineId);
    const result = await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);

    expect(result.status).toBe('PENDING_APPROVAL');
    expect(result.notified).toBe(true);

    const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, s.requestId) });
    expect(row!.submittedBy).toBe(userId);
    // snapshot หัวหน้า ณ ตอนส่ง — เปลี่ยนหัวหน้าแผนกทีหลังต้องไม่ทำให้ค่านี้ขยับ
    expect(row!.assignedManagerId).toBe(s.managerUserId);
    expect(row!.notifiedAt).not.toBeNull();
  });

  test('updatedAt ไม่ตรงกับที่หน้าจอถืออยู่ = มีคนแก้ไปแล้ว ต้อง 409', async () => {
    const s = await scenario('PO-V2');
    await register(s.requestId, s.grpoLineId);
    expect(submitRequest(s.requestId, '2000-01-01T00:00:00.000Z', userId)).rejects.toThrow(
      /ถูกแก้ไขโดยผู้อื่น/,
    );
    expect(await statusOf(s.requestId)).toBe('DRAFT');
  });

  test('ส่งซ้ำใบที่รออนุมัติอยู่ไม่ได้', async () => {
    const s = await scenario('PO-V3');
    await register(s.requestId, s.grpoLineId);
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);

    expect(submitRequest(s.requestId, await updatedAtOf(s.requestId), userId)).rejects.toThrow(
      /DRAFT หรือ REJECTED/,
    );
  });

  test('อนุมัติได้เฉพาะใบที่รออนุมัติ — ใบ DRAFT กดอนุมัติตรง ๆ ไม่ได้', async () => {
    const s = await scenario('PO-V4');
    expect(approveRequest(s.requestId, s.managerUserId)).rejects.toThrow(/เฉพาะคำขอที่รออนุมัติ/);
  });

  test('ตีกลับแล้วแก้แล้วส่งใหม่ได้ (REJECTED ทำงานเหมือน DRAFT)', async () => {
    const s = await scenario('PO-V5');
    await register(s.requestId, s.grpoLineId);
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);
    await rejectRequest(s.requestId, s.managerUserId, 'ราคาไม่ตรงกับใบเสนอราคา', 'MANAGER');

    expect(await statusOf(s.requestId)).toBe('REJECTED');
    const again = await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);
    expect(again.status).toBe('PENDING_APPROVAL');
  });

  test('ตีกลับแล้ว หน้าตารางต้องได้ทั้งสถานะและเหตุผลจากเส้นเดียวกัน', async () => {
    const s = await scenario('PO-V7');
    await register(s.requestId, s.grpoLineId);
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);
    await rejectRequest(s.requestId, s.managerUserId, 'ราคาเกินงบที่อนุมัติไว้', 'MANAGER');

    const slots = await findSlotsByRequest(s.requestId);
    expect(slots.status).toBe('REJECTED');
    expect(slots.rejectReason).toBe('ราคาเกินงบที่อนุมัติไว้');
  });

  test('ส่งใหม่หลังถูกตีกลับ = เหตุผลเก่าต้องไม่ค้างมาหลอกผู้ใช้', async () => {
    // submitRequest ไม่ได้ล้าง rejectReason ทิ้ง (คอลัมน์ยังเก็บไว้เป็นประวัติ) — ถ้าส่งค่าดิบ
    // ออกไป หน้าจอจะขึ้นแบนเนอร์ "ถูกตีกลับเพราะ..." บนใบที่กำลังรออนุมัติรอบใหม่อยู่
    const s = await scenario('PO-V8');
    await register(s.requestId, s.grpoLineId);
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);
    await rejectRequest(s.requestId, s.managerUserId, 'ราคาเกินงบ', 'MANAGER');
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);

    const slots = await findSlotsByRequest(s.requestId);
    expect(slots.status).toBe('PENDING_APPROVAL');
    expect(slots.rejectReason).toBeNull();
  });

  test('อนุมัติแล้วอนุมัติซ้ำไม่ได้', async () => {
    const s = await scenario('PO-V6');
    await register(s.requestId, s.grpoLineId);
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);
    await approveRequest(s.requestId, s.managerUserId);

    expect(await statusOf(s.requestId)).toBe('APPROVED');
    expect(approveRequest(s.requestId, s.managerUserId)).rejects.toThrow(/เฉพาะคำขอที่รออนุมัติ/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ขั้นบัญชี: ออกเลขสินทรัพย์รายชิ้น', () => {
  /** เดินทั้ง flow จนใบเป็น APPROVED แล้วคืน id ของชิ้นที่ลงไว้ */
  async function approved(poNumber: string, pieces = 2) {
    const s = await scenario(poNumber);
    const ids: number[] = [];
    for (let i = 0; i < pieces; i++) ids.push((await register(s.requestId, s.grpoLineId)).id);
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);
    await approveRequest(s.requestId, s.managerUserId);
    return { ...s, assetIds: ids };
  }

  test('ใบที่ยังไม่อนุมัติออกเลขไม่ได้', async () => {
    const s = await scenario('PO-W1');
    const a = await register(s.requestId, s.grpoLineId);
    expect(assignAssetNumber(s.requestId, a.id, 'COM-775-26-001', userId)).rejects.toThrow(
      /เฉพาะคำขอที่อนุมัติแล้ว/,
    );
  });

  test('ออกเลขสำเร็จ = ชิ้นนั้นเป็น REGISTERED และ remaining นับถอยลง', async () => {
    const s = await approved('PO-W2');
    const first = await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-001', userId);
    expect(first.asset.lifecycle).toBe('REGISTERED');
    expect(first.remaining).toBe(1);

    const second = await assignAssetNumber(s.requestId, s.assetIds[1]!, 'COM-775-26-002', userId);
    expect(second.remaining).toBe(0);
  });

  test('เลขซ้ำต้องถูกปฏิเสธพร้อมบอกว่าไปชนกับชิ้นไหน', async () => {
    const s = await approved('PO-W3');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-010', userId);
    expect(
      assignAssetNumber(s.requestId, s.assetIds[1]!, 'COM-775-26-010', userId),
    ).rejects.toThrow(/ถูกใช้แล้วโดยสินทรัพย์ id/);
  });

  test('ชิ้นที่ถูกลบแล้วต้องคืนเลขให้ใช้ซ้ำได้ (uq_asset_number เป็น partial index)', async () => {
    const s = await approved('PO-W4');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-020', userId);
    await db
      .update(asset)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(asset.id, s.assetIds[0]!));

    const reused = await assignAssetNumber(s.requestId, s.assetIds[1]!, 'COM-775-26-020', userId);
    expect(reused.asset.assetNumber).toBe('COM-775-26-020');
  });

  // ★ เส้นตายของการแก้เลขคือ "แจ้งผลกลับผู้ขอ" ไม่ใช่ "กรอกเลขเสร็จ"
  // บัญชีพิมพ์ผิดได้และมักรู้ตัวตอนไล่ตรวจทั้งใบก่อนกด Submit — ล็อกตั้งแต่กรอกทีละชิ้น
  // แปลว่าพิมพ์ผิดตัวเดียวต้องไปแก้ที่ DB เอง
  test('แก้เลขที่กรอกผิดได้ ตราบใดที่ยังไม่ได้แจ้งผลกลับผู้ขอ', async () => {
    const s = await approved('PO-W5');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-030', userId);

    const fixed = await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-031', userId);
    expect(fixed.asset.assetNumber).toBe('COM-775-26-031');
    expect(fixed.asset.lifecycle).toBe('REGISTERED');
    // ชิ้นเดิมชิ้นเดียว ไม่ใช่ชิ้นใหม่ — remaining ต้องไม่ขยับ
    expect(fixed.remaining).toBe(1);

    // เลขเดิมของตัวเองต้องไม่ถูกนับเป็น "เลขซ้ำ" (ด่านซ้ำต้องข้ามตัวเอง)
    const same = await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-031', userId);
    expect(same.asset.assetNumber).toBe('COM-775-26-031');
  });

  test('เลขที่แก้ต้องไม่ไปชนของชิ้นอื่น', async () => {
    const s = await approved('PO-W5B');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-032', userId);
    await assignAssetNumber(s.requestId, s.assetIds[1]!, 'COM-775-26-033', userId);
    expect(
      assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-033', userId),
    ).rejects.toThrow(/ถูกใช้แล้วโดยสินทรัพย์ id/);
  });

  test('ชิ้นที่ปิดถาวรอยู่ ออกเลขทับไม่ได้ ต้องปลดการปิดก่อน', async () => {
    const s = await approved('PO-W5C');
    await cancelAsset(s.requestId, s.assetIds[0]!, 'ของชำรุด ส่งคืน', userId);
    expect(
      assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-034', userId),
    ).rejects.toThrow(/ปิดถาวร/);
  });

  test('ยิง assetId ของใบอื่นผ่าน URL ของใบนี้ไม่ได้', async () => {
    const mine = await approved('PO-W6');
    const other = await approved('PO-W7');
    expect(
      assignAssetNumber(mine.requestId, other.assetIds[0]!, 'COM-775-26-040', userId),
    ).rejects.toThrow(/Asset .* ในคำขอ/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ปิดงาน: แจ้งผลกลับผู้ขอ (confirmRegistration)', () => {
  async function readyToConfirm(poNumber: string, opts: { requesterEmail?: string | null } = {}) {
    const employeeId = await makeEmployee({
      email: opts.requesterEmail === undefined ? 'requester@example.com' : opts.requesterEmail,
    });
    const requesterId = await makeUser({ employeeId, displayName: 'ผู้ขอทดสอบ' });

    const s = await scenario(poNumber);
    const a1 = await register(s.requestId, s.grpoLineId);
    const a2 = await register(s.requestId, s.grpoLineId);
    // ผู้รับอีเมลคือ "คนกดส่ง" ไม่ใช่ ownerPr ของ PO
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), requesterId);
    await approveRequest(s.requestId, s.managerUserId);
    return { ...s, requesterId, assetIds: [a1.id, a2.id] };
  }

  test('ยังออกเลขไม่ครบ ยืนยันไม่ได้ และต้องบอกว่าเหลือกี่ชิ้น', async () => {
    const s = await readyToConfirm('PO-X1');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-100', userId);
    expect(confirmRegistration(s.requestId, userId)).rejects.toThrow(/เหลืออีก 1 ชิ้น/);
  });

  test('ชิ้นที่ถูกตัดทิ้งไม่ถือว่า "ค้าง" — ตัดทิ้งแล้วยืนยันได้เลย', async () => {
    const s = await readyToConfirm('PO-X2');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-110', userId);
    await cancelAsset(s.requestId, s.assetIds[1]!, 'ของชำรุด ส่งคืน', userId);

    const result = await confirmRegistration(s.requestId, userId);
    expect(result.notified).toBe(true);
  });

  test('ผู้ส่งคำขอไม่มีอีเมล = ปิดงานได้ แต่ต้องบอกว่าเมลไม่ได้ออก (0018)', async () => {
    // ★ กติกาเปลี่ยนจากเดิมที่บล็อกด้วย 409: "ไม่มีอีเมล" ไม่ใช่ความล้มเหลวชั่วคราวที่ลองใหม่
    // แล้วจะหาย มันคือข้อมูล HR ที่ไม่มีให้ตั้งแต่แรก (ในกลุ่มผู้ขอ PO 64 คน มี 28 คนที่ไม่มี
    // อีเมลจากแหล่งไหนเลย) ถ้าบล็อกไว้ ใบของคนกลุ่มนั้นจะค้างคิวบัญชีถาวรโดยไม่มีทางออก
    // — ปิดงานตามปกติแล้วคืน notified:false ให้หน้าจอเตือนบัญชีว่าต้องไปแจ้งด้วยวิธีอื่น
    const s = await readyToConfirm('PO-X3', { requesterEmail: null });
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-120', userId);
    await assignAssetNumber(s.requestId, s.assetIds[1]!, 'COM-775-26-121', userId);

    const result = await confirmRegistration(s.requestId, userId);
    expect(result.outcome).toBe('COMPLETE');
    expect(result.notified).toBe(false);
    expect(result.notifyError).toMatch(/ไม่มีอีเมล/);
    // ลองใหม่ไม่ช่วยอะไร จึงไม่ใช่เคสที่ให้กดซ้ำ — ต่างจาก Teams ล่ม
    expect(result.retryable).toBe(false);

    const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, s.requestId) });
    expect(row!.completeNotifiedAt).not.toBeNull(); // งานปิดแล้ว ใบหลุดจากคิว
    expect(row!.completedBy).toBe(userId);
    expect(row!.completeNotifyError).toMatch(/ไม่มีอีเมล/); // แต่ร่องรอยว่าเมลไม่ออกยังอยู่
  });

  test('ยืนยันสำเร็จ = บันทึกคนกดและเวลา แล้วยืนยันซ้ำไม่ได้', async () => {
    const s = await readyToConfirm('PO-X4');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-130', userId);
    await assignAssetNumber(s.requestId, s.assetIds[1]!, 'COM-775-26-131', userId);

    const result = await confirmRegistration(s.requestId, userId);
    expect(result.notified).toBe(true);

    const row = await db.query.assetRequest.findFirst({ where: eq(assetRequest.id, s.requestId) });
    expect(row!.completedBy).toBe(userId);
    expect(row!.completeNotifiedAt).not.toBeNull();

    expect(confirmRegistration(s.requestId, userId)).rejects.toThrow(/แจ้งผลกลับผู้ขอไปแล้ว/);
  });

  test('ใบที่ยังไม่อนุมัติ ยืนยันไม่ได้', async () => {
    const s = await scenario('PO-X5');
    expect(confirmRegistration(s.requestId, userId)).rejects.toThrow(/เฉพาะคำขอที่อนุมัติแล้ว/);
  });

  // ★ คู่กับ 'แก้เลขที่กรอกผิดได้...' ในหมวดบัญชี — แจ้งผลไปแล้วคือปิดประตูแก้เลข
  // เลขชุดนั้นอยู่ในอีเมลของผู้ขอแล้ว (เอาไปติดป้าย/ตรวจรับ) แก้ฝั่งเราอย่างเดียวจะไม่ตรงกัน
  test('แจ้งผลกลับผู้ขอแล้ว แก้เลขไม่ได้อีก', async () => {
    const s = await readyToConfirm('PO-X6');
    await assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-140', userId);
    await assignAssetNumber(s.requestId, s.assetIds[1]!, 'COM-775-26-141', userId);
    await confirmRegistration(s.requestId, userId);

    expect(
      assignAssetNumber(s.requestId, s.assetIds[0]!, 'COM-775-26-142', userId),
    ).rejects.toThrow(/แจ้งผลกลับผู้ขอไปแล้ว/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('lifecycle ของชิ้น: DRAFT → REGISTERED / CANCELLED', () => {
  // ★ ยกเลิกชิ้นที่ออกเลขไปแล้วได้ ตราบใดที่ยังไม่ได้แจ้งผลกลับผู้ขอ (เส้นตายเดียวกับแก้เลข/ตีกลับ)
  // เลข "ต้องไม่ถูกล้าง" — ปิดถาวรเป็นคำสั่งที่ปลดได้ ถ้าล้างตอนปิด คนกดผิดปุ่มแล้วกดกลับ
  // จะได้ชิ้นเปล่าที่ต้องไปตามหาเลขเดิมมากรอกใหม่เอง
  test('ยกเลิกชิ้นที่ออกเลขแล้วได้ก่อน Submit และปลดการปิดแล้วได้สภาพเดิมคืน', async () => {
    const s = await scenario('PO-Y1');
    const a = await register(s.requestId, s.grpoLineId);
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);
    await approveRequest(s.requestId, s.managerUserId);
    await assignAssetNumber(s.requestId, a.id, 'COM-775-26-200', userId);

    await cancelAsset(s.requestId, a.id, 'เปลี่ยนใจ', userId);
    const cancelled = await db.query.asset.findFirst({ where: eq(asset.id, a.id) });
    expect(cancelled!.lifecycle).toBe('CANCELLED');
    expect(cancelled!.assetNumber).toBe('COM-775-26-200');

    await uncancelAsset(s.requestId, a.id, userId);
    const restored = await db.query.asset.findFirst({ where: eq(asset.id, a.id) });
    // กลับเป็น REGISTERED ไม่ใช่ DRAFT — ก่อนปิดมันมีเลขอยู่แล้ว
    expect(restored!.lifecycle).toBe('REGISTERED');
    expect(restored!.assetNumber).toBe('COM-775-26-200');
    expect(restored!.cancelReason).toBeNull();
  });

  test('ปลดการปิดชิ้นที่ยังไม่เคยมีเลข = กลับเป็น DRAFT ตามเดิม', async () => {
    const s = await scenario('PO-Y1B');
    const a = await register(s.requestId, s.grpoLineId);
    await cancelAsset(s.requestId, a.id, 'นับเกิน', userId);

    await uncancelAsset(s.requestId, a.id, userId);
    const row = await db.query.asset.findFirst({ where: eq(asset.id, a.id) });
    expect(row!.lifecycle).toBe('DRAFT');
    expect(row!.assetNumber).toBeNull();
  });

  test('ยกเลิกซ้ำไม่ได้ และเหตุผลต้องถูกบันทึกไว้ตอบย้อนหลัง', async () => {
    const s = await scenario('PO-Y2');
    const a = await register(s.requestId, s.grpoLineId);
    await cancelAsset(s.requestId, a.id, 'นับเกินจากที่รับจริง', userId);

    const row = await db.query.asset.findFirst({ where: eq(asset.id, a.id) });
    expect(row!.lifecycle).toBe('CANCELLED');
    expect(row!.cancelReason).toBe('นับเกินจากที่รับจริง');
    expect(row!.cancelledBy).toBe(userId);

    expect(cancelAsset(s.requestId, a.id, 'ซ้ำ', userId)).rejects.toThrow(/ถูกยกเลิกไปแล้ว/);
  });

  test('ชิ้นที่ถูกตัดทิ้งต้องไม่ถูกนับเป็นยอดที่ส่งขออนุมัติ', async () => {
    const s = await scenario('PO-Y3');
    const a1 = await register(s.requestId, s.grpoLineId);
    await register(s.requestId, s.grpoLineId);
    await cancelAsset(s.requestId, a1.id, 'ส่งคืน', userId);

    // ยังส่งได้ปกติ (เหลือ 1 ชิ้นที่ยังมีชีวิต) — ด่าน "ใบเปล่า" ต้องไม่มาสะดุดตรงนี้
    const result = await submitRequest(s.requestId, await updatedAtOf(s.requestId), userId);
    expect(result.status).toBe('PENDING_APPROVAL');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('ความสอดคล้องของข้อมูลอ้างอิง', () => {
  test('แผนก/พนักงานที่ถูกปิดใช้งานแล้ว เลือกมาลงทะเบียนไม่ได้', async () => {
    const s = await scenario('PO-Z1');
    const employeeId = await makeEmployee();
    await db.update(employee).set({ isActive: false }).where(eq(employee.id, employeeId));

    expect(register(s.requestId, s.grpoLineId, { employeeId })).rejects.toThrow(/ไม่ได้ทำงานแล้ว/);
  });

  test('บัญชีผู้ใช้ที่ถูกปิดใช้งาน ไม่ถูกเลือกเป็นผู้อนุมัติ', async () => {
    const s = await scenario('PO-Z2');
    await db.update(user).set({ isActive: false }).where(eq(user.id, s.managerUserId));
    await register(s.requestId, s.grpoLineId);

    expect(submitRequest(s.requestId, await updatedAtOf(s.requestId), userId)).rejects.toThrow(
      /ยังไม่มีบัญชีผู้ใช้ที่อนุมัติได้/,
    );
    expect(await statusOf(s.requestId)).toBe('DRAFT');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ═══ ชื่อคนในคิวของบัญชี ═══
//
// ต้องเป็นชื่อพนักงานจาก HR (firstName + lastName) ไม่ใช่ user.displayName ซึ่งเป็นชื่อบัญชี
// ที่ตั้งเองได้ ซ้ำกันได้ และหลายคนตั้งเป็นชื่อเล่น/username — บัญชีที่ต้องไล่ถามว่า
// "ใบนี้ใครส่งมา" อ่านชื่อเล่นแล้วไม่รู้ว่าเป็นใคร และไม่ตรงกับชื่อบนเอกสารใบอื่น
describe('คิวออกเลขของบัญชี — ชื่อคนที่โชว์', () => {
  test('ผู้ส่ง/ผู้อนุมัติ ใช้ชื่อพนักงาน ไม่ใช่ displayName ของบัญชี', async () => {
    const employeeId = await makeEmployee();
    const submitterUserId = await makeUser({
      displayName: 'nat.s', // ชื่อบัญชีแบบที่คนตั้งกันจริง — ห้ามโผล่บนหน้าจอ
      employeeId,
    });
    const s = await scenario('PO-NAME1');
    await register(s.requestId, s.grpoLineId);
    await register(s.requestId, s.grpoLineId);
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), submitterUserId);
    await approveRequest(s.requestId, s.managerUserId);

    const emp = await db.query.employee.findFirst({ where: eq(employee.id, employeeId) });
    const expected = `${emp!.firstName} ${emp!.lastName}`;

    const row = await getPendingRegistration(s.requestId);
    expect(row.submittedByName).toBe(expected);
    expect(row.submittedByName).not.toBe('nat.s');

    // ผู้อนุมัติมาจากคนละ join ต้องเช็คด้วย — เคยพลาดกันบ่อยตรงที่แก้ตัวเดียวแล้วลืมอีกตัว
    const mgr = await db.query.employee.findFirst({ where: eq(employee.id, s.managerEmployeeId) });
    expect(row.approvedByName).toBe(`${mgr!.firstName} ${mgr!.lastName}`);
    expect(row.approvedByName).not.toBe('หัวหน้าทดสอบ');

    // ลิสต์ต้องได้ชื่อชุดเดียวกับใบเดี่ยว — สองเส้นนี้แชร์คิวรีเดียวกันอยู่ ถ้าวันหลังแยกกัน
    // เมื่อไหร่ ชื่อในตารางกับในหน้าฟอร์มจะเป็นคนละแบบโดยไม่มีใครสังเกต
    const list = await listPendingRegistration({ page: 1, limit: 10 });
    const listed = list.data.find((r) => r.requestId === s.requestId);
    expect(listed!.submittedByName).toBe(expected);
  });

  test('บัญชีที่ยังไม่ผูกพนักงาน ตกไปใช้ displayName ไม่ใช่ค่าว่าง', async () => {
    // service account / คนที่ยังจับคู่กับข้อมูล HR ไม่ได้ — ต้องยังรู้ว่าใครส่งใบมา
    const orphanUserId = await makeUser({ displayName: 'บัญชีไม่ผูกพนักงาน' });
    const s = await scenario('PO-NAME2');
    await register(s.requestId, s.grpoLineId);
    await register(s.requestId, s.grpoLineId);
    await submitRequest(s.requestId, await updatedAtOf(s.requestId), orphanUserId);
    await approveRequest(s.requestId, s.managerUserId);

    const row = await getPendingRegistration(s.requestId);
    expect(row.submittedByName).toBe('บัญชีไม่ผูกพนักงาน');
  });
})
