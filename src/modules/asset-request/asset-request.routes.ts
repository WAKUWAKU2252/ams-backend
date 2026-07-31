// ท่อบาง ๆ: แกะ request -> เรียก service -> ส่งกลับ (ห้าม logic/query DB)
// identity มาจาก authGuard (currentUser.id) เท่านั้น — ไม่รับ createBy จาก client อีก
import { Elysia } from 'elysia';
import {
  createDraftBody,
  requestIdParams,
  listQuery,
  submitBody,
  rejectBody,
  declareLineParams,
  declareLineBody,
} from './asset-request.schema';
import * as assetRequestService from './asset-request.service';
import * as assetRequestLineService from './asset-request-line.service';
import * as presenceService from './presence.service';
import { authGuard, requireRole } from '../../plugins/auth';

// approve/reject เป็นสิทธิ์ manager เท่านั้น — คุมด้วย requireRole (401 ถ้าไม่ล็อกอิน / 403 ถ้า role ไม่ตรง)
const managerRoutes = new Elysia()
  .use(authGuard)
  .use(requireRole('MANAGER'))
  .post('/:id/approve', ({ params, currentUser }) => assetRequestService.approveRequest(params.id, currentUser.id), {
    params: requestIdParams,
  })
  .post('/:id/reject', ({ params, body, currentUser }) => assetRequestService.rejectRequest(params.id, currentUser.id, body.reason), {
    params: requestIdParams,
    body: rejectBody,
  });

export const assetRequestRoutes = new Elysia({ prefix: '/asset-requests' })
  .use(authGuard)
  .post('/', ({ body, currentUser }) => assetRequestService.createDraft(body.poNumber, currentUser.id), {
    body: createDraftBody,
  })
  .get('/', ({ query, currentUser }) => assetRequestService.listMyDrafts(currentUser.id, query), {
    query: listQuery,
  })
  .get('/:id', ({ params, currentUser }) => assetRequestService.getDraft(params.id, currentUser.id), {
    params: requestIdParams,
  })
  // presence (SSE): เปิดสาย = เข้าห้อง PO นี้ + พยายามถือ lock / ปิดสาย = ปล่อย + promote หัวคิว
  .get('/:id/presence', ({ params, currentUser, request }) => presenceService.openPresence(params.id, currentUser.id, request.signal), {
    params: requestIdParams,
  })
  // สิทธิ์เดียวที่ผู้ใช้มีกับใบคำขอ: เอาออกจากลิสต์ของตัวเอง — ใบยังอยู่ ไม่มีใครลบของคนอื่นได้
  .delete('/:id/opener', ({ params, currentUser }) => assetRequestService.leaveRequest(params.id, currentUser.id), {
    params: requestIdParams,
  })
  // แจ้งจำนวนชิ้นของรอบรับของ (PO งานเหมา) — service เช็ค lock + สถานะให้แล้ว
  .put(
    '/:id/lines/:grpoLineId',
    ({ params, body, currentUser }) =>
      assetRequestLineService.declareLine(
        params.id,
        params.grpoLineId,
        body.declaredQty,
        body.reason,
        currentUser.id,
      ),
    { params: declareLineParams, body: declareLineBody },
  )
  // ยกเลิกการแจ้ง กลับไปใช้จำนวนที่ SAP บอก
  .delete(
    '/:id/lines/:grpoLineId',
    ({ params, currentUser }) =>
      assetRequestLineService.removeDeclaredLine(params.id, params.grpoLineId, currentUser.id),
    { params: declareLineParams },
  )
  // ส่งเข้าอนุมัติ — ผู้แก้กดเอง (auth พอ) + optimistic updatedAt
  .post('/:id/submit', ({ params, body }) => assetRequestService.submitRequest(params.id, body.expectedUpdatedAt), {
    params: requestIdParams,
    body: submitBody,
  })
  .use(managerRoutes);
