// ท่อบาง ๆ: แกะ request -> เรียก service -> ส่งกลับ (ห้าม logic/try-catch/query DB)
import { Elysia } from 'elysia';
import { createUserBody } from './user.schema';
import * as userService from './user.service';

// ยังไม่คุมสิทธิ์ — endpoint ชั่วคราวสำหรับสร้าง user ตอน dev
// ก่อนขึ้นใช้จริงต้องครอบด้วย requireRole(...) จาก plugins/auth
export const userRoutes = new Elysia({ prefix: '/users' })
  .post('/', ({ body }) => userService.createUser(body), { body: createUserBody });
