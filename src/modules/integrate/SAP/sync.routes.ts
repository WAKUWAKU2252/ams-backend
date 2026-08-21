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
  .use(requireRole('FINANCE', 'ADMIN'))
  .post('/', ({ currentUser }) => syncService.syncAll('BUTTON', currentUser.id))
  .post('/:entity', ({ params, currentUser }) => syncService.syncOne(params.entity, 'BUTTON', currentUser.id), {
    params: t.Object({ entity: t.String() }),
  });

export const syncRoutes = new Elysia({ prefix: '/sync' })
  .use(authGuard)
  // ใครก็ดูได้ — เป็นสถานะของ job ไม่ใช่ข้อมูลธุรกิจ (หน้าจอเอาไปโชว์ว่าข้อมูลสดแค่ไหน)
  .get('/status', () => syncService.getStatus())
  .use(triggerRoutes);
