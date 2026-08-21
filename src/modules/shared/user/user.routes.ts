// ท่อบาง ๆ: แกะ request -> เรียก service -> ส่งกลับ (ห้าม logic/try-catch/query DB)
import { Elysia } from 'elysia';
import { createUserBody } from './user.schema';
import * as userService from './user.service';
import { authGuard, requireRole } from '@plugins/auth';

// สร้าง user เป็นสิทธิ์ ADMIN เท่านั้น — body รับ roleId มาจาก client ตรง ๆ
// ถ้าเปิดให้ยิงได้โดยไม่ล็อกอิน ใครก็สร้าง account role ADMIN ให้ตัวเองแล้วข้าม
// requireRole ทั้งระบบได้ในคำสั่งเดียว
// ต้อง .use(authGuard) ตรงนี้ด้วย ห้ามพึ่ง authGuard ที่อยู่ข้างใน requireRole:
// derive ของ authGuard เป็น 'scoped' ซึ่งกระจายขึ้นไปแค่ชั้นเดียว (ถึง instance ของ
// requireRole) ไม่ถึง instance นี้ — currentUser จึงเป็น undefined แล้ว onBeforeHandle
// ของ requireRole โยน 401 ทิ้งทุกคำขอ ต่อให้ token เป็น ADMIN ถูกต้องก็ตาม
// (เส้นอื่นที่ใช้ requireRole เช่น asset-request/sync เขียนคู่กันแบบนี้อยู่แล้ว)
export const userRoutes = new Elysia({ prefix: '/users' })
  .use(authGuard)
  .use(requireRole('ADMIN'))
  .post('/', ({ body }) => userService.createUser(body), { body: createUserBody });
