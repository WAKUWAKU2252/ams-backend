// ปุ่มของบัญชีในขั้นออกเลข ห่อด้วยการหยิบ lock ให้อัตโนมัติ
//
// ของจริงบังคับว่าคนกดต้องถือ lock ห้อง registration ของใบนั้นอยู่ (assertRegistrationHolder)
// ซึ่งฝั่ง frontend ได้มาจากการเปิดสาย SSE ค้างไว้ — เทสต์ไม่ได้เปิดสาย จึงต้องหยิบเอง
//
// ไฟล์ที่ import จากที่นี่กำลังทดสอบ "กติกาของปุ่ม" (เพดานจำนวน / lifecycle / สถานะใบ)
// ไม่ใช่กติกา lock ซึ่งทดสอบแยกไว้ที่ presence-lock.test.ts — ที่นั่นเรียก service ตรง ๆ
import * as service from '@modules/business/asset-request/asset-request.service';
import { holdRegistration } from './factory';

export const assignAssetNumber: typeof service.assignAssetNumber = (
  requestId,
  assetId,
  assetNumber,
  userId,
) => {
  holdRegistration(requestId, userId);
  return service.assignAssetNumber(requestId, assetId, assetNumber, userId);
};

export const rejectAsset: typeof service.rejectAsset = (
  requestId,
  assetId,
  reason,
  userId,
  role,
) => {
  holdRegistration(requestId, userId);
  return service.rejectAsset(requestId, assetId, reason, userId, role);
};

export const cancelAsset: typeof service.cancelAsset = (requestId, assetId, reason, userId) => {
  holdRegistration(requestId, userId);
  return service.cancelAsset(requestId, assetId, reason, userId);
};

export const uncancelAsset: typeof service.uncancelAsset = (requestId, assetId, userId) => {
  holdRegistration(requestId, userId);
  return service.uncancelAsset(requestId, assetId, userId);
};

export const confirmRegistration: typeof service.confirmRegistration = (requestId, userId) => {
  holdRegistration(requestId, userId);
  return service.confirmRegistration(requestId, userId);
};
