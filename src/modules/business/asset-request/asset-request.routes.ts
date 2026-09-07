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
  assignNumberParams,
  assignNumberBody,
  cancelBody,
} from './asset-request.schema';
import * as assetRequestService from './asset-request.service';
import * as assetRequestLineService from './asset-request-line.service';
import * as presenceService from './presence.service';
import { displayNameOf } from './holder-name';
import { authGuard, requireRole } from '@plugins/auth';
import { paginationQuery } from '@common/pagination';
import { APPROVER_ROLES, REGISTRAR_ROLES } from '@common/roles';

// approve/reject จำกัดด้วย APPROVER_ROLES — คุมด้วย requireRole (401 ถ้าไม่ล็อกอิน / 403 ถ้า role ไม่ตรง)
// ชุด role ต้องตรงกับที่ findApprovalTarget/resolveManagerUserId ใช้ ไม่งั้นจะส่งใบไปหาคนที่กดไม่ได้
const managerRoutes = new Elysia()
  .use(authGuard)
  .use(requireRole(...APPROVER_ROLES))
  .post('/:id/approve', ({ params, currentUser }) => assetRequestService.approveRequest(params.id, currentUser.id), {
    params: requestIdParams,
  })
  // currentUser.role มาจาก JWT — เก็บเป็น snapshot ว่า "ตีกลับมาจาก role ไหน" ไม่ใช่ไปอ่าน
  // role ปัจจุบันตอนแสดงผล (คนย้ายตำแหน่งแล้วประวัติจะเพี้ยนย้อนหลัง)
  .post('/:id/reject', ({ params, body, currentUser }) => assetRequestService.rejectRequest(params.id, currentUser.id, body.reason, currentUser.role), {
    params: requestIdParams,
    body: rejectBody,
  });

// ขั้นบัญชี — คนละชุด role กับ approve/reject โดยตั้งใจ (MANAGER อนุมัติได้แต่ออกเลขไม่ได้)
// ดูเหตุผลที่ REGISTRAR_ROLES ใน common/roles.ts
const registrarRoutes = new Elysia()
  .use(authGuard)
  .use(requireRole(...REGISTRAR_ROLES))
  // คิวงานรายชิ้น — ไม่ใช่รายใบ เพราะเลขจาก SAP ทยอยออกทีละชิ้น
  .get('/pending-registration', ({ query }) => assetRequestService.listPendingRegistration(query), {
    query: paginationQuery,
  })
  // หัวใบใบเดียวของคิวนี้ — หน้าฟอร์มออกเลขใช้ ไม่ใช้ GET /:id (ซึ่งบันทึก opener ให้คนเปิด
  // แล้วใบจะไปโผล่ในลิสต์ "คำขอของฉัน" ของบัญชี)
  .get('/:id/registration', ({ params }) => assetRequestService.getPendingRegistration(params.id), {
    params: requestIdParams,
  })
  // สายของ "หน้าตาราง" — สายเดียวต่อคน บอกว่าใบไหนกำลังถูกใครแก้อยู่
  // ฟังอย่างเดียว ไม่เข้าห้องไหน คนเปิดดูตารางจึงไม่ไปถือ lock หรือแย่งคิวใคร
  // ต้องมาก่อน '/:id/registration-presence' ไม่ได้ — คนละรูปแบบ path ไม่ชนกัน
  .get('/registration-presence', ({ request }) =>
    presenceService.openRegistrationLobby(request.signal),
  )
  // presence ของ "ขั้นบัญชี" — คนละห้องกับ '/:id/presence' ของผู้ขอ แม้เป็นใบเดียวกัน
  // scope มาจาก path ไม่ใช่ query param: ถ้าให้ client เลือกเอง คนที่อยากแก้ทับก็แค่ส่ง
  // scope มั่ว ๆ แล้วได้ห้องว่างที่ตัวเองเป็น holder ทันที — และเส้นนี้อยู่ในกลุ่ม
  // registrarRoutes อยู่แล้ว requireRole จึงคุมให้ฟรีว่าเฉพาะบัญชี/แอดมินเท่านั้นที่เข้าได้
  .get(
    '/:id/registration-presence',
    async ({ params, currentUser, request }) =>
      presenceService.openPresence(
        'registration',
        params.id,
        { id: currentUser.id, name: await displayNameOf(currentUser.id) },
        request.signal,
      ),
    { params: requestIdParams },
  )
  // ใส่เลขทีละชิ้น — ชิ้นสุดท้ายที่ได้เลขจะปิดใบให้เอง (ไม่มี endpoint 'ปิดใบ' แยก)
  .put(
    '/:id/assets/:assetId/number',
    ({ params, body, currentUser }) =>
      assetRequestService.assignAssetNumber(params.id, params.assetId, body.assetNumber, currentUser.id),
    {
      params: assignNumberParams,
      body: assignNumberBody,
      // transform ทำงาน "ก่อน" validation — ต้อง trim ที่นี่ ไม่ใช่ใน service ไม่งั้น
      // minLength: 1 ของ assignNumberBody จะปล่อยค่าที่เป็นช่องว่างล้วนผ่านเข้าไปได้
      //
      // เลขใน SAP เป็นตัวใหญ่เสมอ — 'com-775-26-050' คือเจตนาถูกแค่พิมพ์เล็ก ไม่ใช่ค่าผิด
      // ส่วน trim กัน copy-paste จาก Excel/อีเมลที่ติดช่องว่างหัวท้ายมาด้วย
      //
      // ★ toUpperCase ยังอยู่แม้ถอด pattern ออกแล้ว — เลขในทะเบียนเป็นตัวใหญ่ทั้งหมด
      //   ปล่อยตัวเล็กผ่านจะได้เลขที่ uq_asset_number มองเป็นคนละตัวกับของเดิม
      transform({ body }) {
        const b = body as { assetNumber?: unknown } | undefined;
        if (typeof b?.assetNumber === 'string') {
          b.assetNumber = b.assetNumber.trim().toUpperCase();
        }
      },
    },
  )
  // ยืนยันว่าออกเลขครบแล้ว → แจ้งผลกลับหาผู้ขอ (ปุ่ม Submit ที่หัวใบในตารางบัญชี)
  // เป็นการกดของคน ไม่ derive จาก "เลขครบเมื่อไหร่" — ดูเหตุผลที่ service
  .post('/:id/confirm-registration', ({ params, currentUser }) => assetRequestService.confirmRegistration(params.id, currentUser.id), {
    params: requestIdParams,
  })
  // ── สามปุ่มของบัญชีในขั้นออกเลข แยกหน้าที่กันเด็ดขาด อย่าเอามารวม:
  //      number  ข้อมูลถูก      -> ออกเลข จบ                       (PUT .../number ข้างบน)
  //      reject  ข้อมูลผิด      -> ผู้ขอแก้แล้วกลับเข้าคิว ช่องไม่หาย
  //      cancel  ของไม่เอาแล้ว  -> ปิดถาวร ช่องไม่คืน (ปลดได้ที่ uncancel)
  .post(
    '/:id/assets/:assetId/reject',
    ({ params, body, currentUser }) =>
      assetRequestService.rejectAsset(
        params.id,
        params.assetId,
        body.reason,
        currentUser.id,
        currentUser.role,
      ),
    { params: assignNumberParams, body: rejectBody },
  )
  .post(
    '/:id/assets/:assetId/cancel',
    ({ params, body, currentUser }) =>
      assetRequestService.cancelAsset(params.id, params.assetId, body.reason, currentUser.id),
    { params: assignNumberParams, body: cancelBody },
  )
  // ปลดการปิดถาวร — จำกัดที่ REGISTRAR_ROLES เหมือนปุ่ม cancel: คนที่ปิดได้เท่านั้นที่เปิดคืนได้
  .post(
    '/:id/assets/:assetId/uncancel',
    ({ params, currentUser }) =>
      assetRequestService.uncancelAsset(params.id, params.assetId, currentUser.id),
    { params: assignNumberParams },
  )
  // ── ใบที่การแจ้งเตือนไม่ถึงปลายทาง (A) ─────────────────────────────────────
  //
  // ★ ต้องมาก่อน '/:id' ของ assetRequestRoutes ไม่ได้ — คนละ Elysia instance และ
  //   registrarRoutes ถูก .use() ก่อน จึงชนะอยู่แล้ว (segment คงที่ชนะ dynamic ด้วย)
  //
  // อยู่ใน registrarRoutes จึงได้ requireRole(REGISTRAR_ROLES) ฟรี — บัญชี/แอดมินคือคน
  // ที่เฝ้าคิวนี้อยู่แล้ว และการเปิดให้ทุกคนเห็นเท่ากับเปิดรายการใบของคนอื่นทั้งระบบ
  // ★ เหลือเฉพาะสองอาการที่ "บัญชีเป็นคนกดแก้" — แจ้งปิดงาน/ตีกลับล้ม ซึ่งกู้ด้วยการกด
  //   ปุ่มเดิมซ้ำ ส่วนการ์ดที่ไม่ถึงหัวหน้าย้ายไปฝั่งผู้ขอแล้ว (เขาเป็นคนเดือดร้อนและกดเองได้)
  .get('/notify-stuck', () => assetRequestService.listStuckNotifications());

export const assetRequestRoutes = new Elysia({ prefix: '/asset-requests' })
  .use(authGuard)
  .post('/', ({ body, currentUser }) => assetRequestService.createDraft(body.poNumber, currentUser.id), {
    body: createDraftBody,
  })
  .get('/', ({ query, currentUser }) => assetRequestService.listMyDrafts(currentUser.id, query), {
    query: listQuery,
  })
  // สายของหน้า "คำขอของฉัน" — บอกแค่ว่า "ลิสต์เปลี่ยนแล้ว ไปโหลดใหม่" ไม่มี requestId ในก้อน
  // จึงไม่ต้อง requireRole: ผู้ขอทุกคนเปิดได้และไม่มีข้อมูลใบไหนไหลออกไปเลย (ดู notifyStatus)
  //
  // ต้องมาก่อน '/:id' ไม่ได้ — requestIdParams เป็น t.Numeric() และ Elysia ให้ segment คงที่
  // ชนะ dynamic เสมอ (เหมือน '/pending-registration' ของฝั่งบัญชี)
  .get('/changes', ({ request }) => presenceService.openMyRequestsChanges(request.signal))
  .get('/:id', ({ params, currentUser }) => assetRequestService.getDraft(params.id, currentUser.id), {
    params: requestIdParams,
  })
  // presence (SSE) ของ "ขั้นผู้ขอ": เปิดสาย = เข้าห้อง draft ของใบนี้ + พยายามถือ lock
  // ปิดสาย = ปล่อย + promote หัวคิว — คนละห้องกับ '/:id/registration-presence' ของบัญชี
  .get(
    '/:id/presence',
    async ({ params, currentUser, request }) =>
      presenceService.openPresence(
        'draft',
        params.id,
        { id: currentUser.id, name: await displayNameOf(currentUser.id) },
        request.signal,
      ),
    { params: requestIdParams },
  )
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
  .post('/:id/submit', ({ params, body, currentUser }) => assetRequestService.submitRequest(params.id, body.expectedUpdatedAt, currentUser.id), {
    params: requestIdParams,
    body: submitBody,
  })
  // ใบของตัวเองที่ส่งไปแล้วแต่การ์ดไม่ถึงหัวหน้า — scope ด้วย currentUser.id ที่ service
  // ไม่รับ userId จาก client จึงไม่มีทางถามหาใบของคนอื่น (หลักเดียวกับ GET '/')
  .get('/my-notify-stuck', ({ currentUser }) =>
    assetRequestService.listMyStuckNotifications(currentUser.id))
  // ── ส่งการ์ดขออนุมัติซ้ำ — ไม่แตะสถานะใบ
  //
  // ★ อยู่ในกลุ่มของผู้ขอ ไม่ใช่ registrarRoutes: การ์ดที่ไม่ถึงหัวหน้าทำให้ "ใบของผู้ขอ"
  //   ค้าง เขาจึงเป็นคนที่รู้ก่อนและควรกดเองได้ ไม่ต้องรอบัญชีมาสังเกตให้
  //
  // ทางเดียวที่กู้เคสนี้ได้ — submit ซ้ำไม่ได้เพราะ isEditableStatus ปฏิเสธใบที่เป็น
  // PENDING_APPROVAL ไปแล้ว (คอมเมนต์ใน submitRequest เตือนเรื่องนี้ไว้เอง)
  //
  // ไม่ต้อง requireRole — service เช็คความเป็นเจ้าของผ่าน assetRequestOpener เอง
  // (ตัวเดียวกับที่ listMyDrafts ใช้กรอง) กดได้เฉพาะใบตัวเอง หนึ่งใบ = หนึ่งการ์ด
  .post('/:id/notify-retry', ({ params, currentUser }) =>
    assetRequestService.retryNotifyApprover(params.id, currentUser.id), {
    params: requestIdParams,
  })
  .use(managerRoutes)
  // ต้องมาหลัง .get('/:id') ได้ — router ของ Elysia ให้ segment คงที่ชนะ dynamic เสมอ
  // '/pending-registration' จึงไม่ตกไปเข้า '/:id' (ซึ่งเป็น t.Numeric() แล้วจะ 422)
  .use(registrarRoutes);
