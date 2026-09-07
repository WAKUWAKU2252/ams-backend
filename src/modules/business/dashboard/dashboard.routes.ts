// ท่อบาง ๆ: แกะของจาก request -> เรียก service -> ส่งของกลับ
// ห้ามมี logic / ห้าม try-catch (error-handler แปลง AppError ให้เอง) / ห้าม query DB
//
// ไม่มี requireRole ที่ระดับเส้นทางโดยตั้งใจ — ทุก role เปิดหน้า Dashboard ได้ แต่ "เห็นแค่ไหน"
// ต่างกัน ซึ่งเป็นเรื่องของขอบเขตข้อมูล ไม่ใช่เรื่องเข้าถึงหน้าได้/ไม่ได้ ตัวบังคับอยู่ที่
// resolveDepartmentScope / resolveCompanyScope ใน service ซึ่งอ่าน role จาก token (ดูหัวไฟล์ dashboard.service.ts ข้อ 1)
import { Elysia } from 'elysia';
import { dashboardOverviewQuery } from './dashboard.schema';
import * as dashboardService from './dashboard.service';
import { authGuard } from '@plugins/auth';

export const dashboardRoutes = new Elysia({ prefix: '/dashboard' })
  .use(authGuard)
  .get('/overview', ({ query, currentUser }) => dashboardService.overview(currentUser, query), {
    query: dashboardOverviewQuery,
  });
