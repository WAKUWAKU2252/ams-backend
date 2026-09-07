// ท่อบาง ๆ: แกะของจาก request -> เรียก service -> ส่งของกลับ
// ห้ามมี logic / ห้าม try-catch (error-handler แปลง AppError ให้เอง) / ห้าม query DB
import { Elysia, t } from 'elysia';
import * as syncService from './sync.service';
import { authGuard, requireRole } from '@plugins/auth';

// สั่ง sync เองเป็นสิทธิ์ finance — ปุ่มนี้ยิงไป DB จริงของบริษัท ไม่ควรให้ใครกดรัว ๆ ได้
// (engine กันซ้ำสองชั้น: advisory lock กันรันซ้อน + cooldown กันกดถี่ ทั้งคู่คืน SKIPPED
//  พร้อมเหตุผลโดยไม่แตะ SAP เลย — สิทธิ์ตรงนี้จึงเป็นเรื่องว่า "ใครควรสั่งได้" ล้วน ๆ)
const triggerRoutes = new Elysia()
  .use(authGuard)
  // ต้องใส่ทุก role ในการเรียกครั้งเดียว — requireRole เป็น OR (role ไหนก็ได้ในลิสต์)
  // เรียกซ้อนสองครั้งจะกลายเป็น AND: hook ตัวที่สองโยน 403 ทิ้งทุกคนที่ผ่านตัวแรกมา
  // ซึ่งไม่มีทางผ่านได้เลยเพราะ user หนึ่งคนมี role เดียว
  .use(requireRole('FINANCE', 'ADMIN', 'MANAGER'))
  // ทุกบริษัท ทุก entity — ผลคืนเป็น { [companyCode]: { purchase_order, grpo, asset } }
  .post('/', ({ currentUser }) => syncService.syncAll('BUTTON', currentUser.id))
  // ทุก entity ของบริษัทเดียว (0021)
  .post(
    '/company/:company',
    ({ params, currentUser }) => syncService.syncAllForCompany(params.company, 'BUTTON', currentUser.id),
    { params: t.Object({ company: t.String() }) },
  )
  // entity เดียวของบริษัทเดียว — บริษัทมาก่อนใน path เพราะเป็นขอบเขตที่กว้างกว่า
  .post(
    '/company/:company/:entity',
    ({ params, currentUser }) =>
      syncService.syncOne(params.entity, params.company, 'BUTTON', currentUser.id),
    { params: t.Object({ company: t.String(), entity: t.String() }) },
  );

// ── เส้นที่ "ทุกคนที่ล็อกอิน" เรียกได้ ────────────────────────────────────────
//
// ★ ต้องประกาศก่อน .use(triggerRoutes) เสมอ — requireRole ข้างในนั้นเป็น hook แบบ scoped
//   ซึ่งมีผลกับ route ที่ประกาศ "หลัง" มันเท่านั้น ย้ายบล็อกนี้ลงไปอยู่ล่างเมื่อไหร่
//   ปุ่มบนหน้าจอจะ 403 ให้ EMPLOYEE ทุกคนทันที โดยที่โค้ดยังหน้าตาถูกต้องอยู่
export const syncRoutes = new Elysia({ prefix: '/sync' })
  .use(authGuard)
  // ใครก็ดูได้ — เป็นสถานะของ job ไม่ใช่ข้อมูลธุรกิจ (หน้าจอเอาไปโชว์ว่าข้อมูลสดแค่ไหน)
  .get('/status', () => syncService.getStatus())
  // "ฉันสั่ง sync อะไรได้บ้าง" — หน้าจอใช้ตัดสินว่าจะวาดปุ่มยังไง (ดู getScope)
  .get('/scope', ({ currentUser }) => syncService.getScope(currentUser))
  // ★ ต้องมาก่อน '/company/:company/:entity' ของ triggerRoutes — ไม่งั้น 'documents'
  //   จะถูกจับเป็นชื่อ entity แล้วตกด่าน requireRole กลายเป็น 403 ทั้งที่เส้นนี้เปิดให้ทุกคน
  //
  // ปุ่มบน TopBar เรียกเส้นนี้เส้นเดียว — PO + GRPO ของบริษัทเดียว
  // ด่านบริษัทอยู่ใน service (ไฟล์นี้ห้ามมี logic/ห้าม query DB) ดู assertCanSyncCompany
  .post(
    '/company/:company/documents',
    ({ params, currentUser }) =>
      syncService.syncDocumentsForCompany(params.company, 'BUTTON', currentUser),
    { params: t.Object({ company: t.String() }) },
  )
  .use(triggerRoutes);
