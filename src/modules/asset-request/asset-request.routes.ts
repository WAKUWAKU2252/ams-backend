import { Elysia } from 'elysia';
import { createDraftBody, requestIdParams, listQuery } from './asset-request.schema';
import * as assetRequestService from './asset-request.service';

export const assetRequestRoutes = new Elysia({ prefix: '/asset-requests' })
  // ★ POST เพราะ "สร้าง resource ใหม่" — และแม้ POST จะไม่ idempotent โดยนิยาม
  //   เราทำให้มัน idempotent เองที่ service (คืนใบเดิม) เพราะปุ่ม Create ถูกกดรัวได้
  .post('/', ({ body }) => assetRequestService.createDraft(body.poNumber, body.createBy), {
    body: createDraftBody,
  })
  // list แบบเบา — ไม่พ่วง relations หนัก รายละเอียดเต็มไปเอาที่ detail ตอนผู้ใช้เลือกใบแล้ว
  .get('/', ({ query }) => assetRequestService.listMyDrafts(query), { query: listQuery })
  // ★ params.id ผ่าน t.Numeric() มาแล้ว = เป็น number จริง ไม่ต้อง parseInt ซ้ำ
  .get('/:id', ({ params }) => assetRequestService.getDraftOrFail(params.id), {
    params: requestIdParams,
  });

// ไม่มี try/catch ทั้งไฟล์ — AppError ที่ service โยน ถูก error-handler กลาง (plugins/setup)
// แปลงเป็น { message } + status ให้เอง (ดักเองเมื่อไหร่ รูปแบบ error จะแตกเป็นสองมาตรฐาน)
