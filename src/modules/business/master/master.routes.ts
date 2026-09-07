// ท่อบาง ๆ: แกะ request -> เรียก service -> ส่งกลับ (ห้าม logic/try-catch/query DB)
//
// authGuard เฉย ๆ ไม่ล็อก role — ชื่อแผนก/หมวดไม่ใช่ข้อมูลลับ และทุก role ที่กรอกฟอร์ม
// asset ต้องใช้ ถ้าใส่ requireRole พนักงานทั่วไปจะกรอกฟอร์มไม่ได้
import { Elysia } from 'elysia';
import { employeeListQuery, masterListQuery } from './master.schema';
import * as masterService from './master.service';
import { authGuard } from '@plugins/auth';

export const masterRoutes = new Elysia({ prefix: '/master' })
  .use(authGuard)
  .get('/departments', ({ query }) => masterService.findDepartments(query), {
    query: masterListQuery,
  })
  // ไม่มี query เพราะไม่มีอะไรให้ค้น/กรอง — ทั้งเครือมีไม่กี่บริษัท คืนครบทีเดียว
  .get('/companies', () => masterService.findCompanies())
  .get('/categories', ({ query }) => masterService.findCategories(query), {
    query: masterListQuery,
  })
  // ไม่มี /uoms แล้ว (ถอดใน 0011) — หน่วยนับมาจาก SAP เป็น string ติดมากับตัว asset
  // ไม่ใช่ตัวเลือกที่ผู้ใช้เลือกเอง จึงไม่ต้องมี dropdown ให้เลือก
  .get('/locations', ({ query }) => masterService.findLocations(query), {
    query: masterListQuery,
  })
  // คืนครบทุกสถานที่ ไม่กรองตาม locationId — frontend กรองเองตอนผู้ใช้เลือกสถานที่
  .get('/sub-locations', ({ query }) => masterService.findSubLocations(query), {
    query: masterListQuery,
  })
  // เส้นเดียวที่แบ่งหน้า — employee ใหญ่ระดับทั้งบริษัท ตัวอื่นคืนครบเพราะหลักสิบแถว
  .get('/employees', ({ query }) => masterService.findEmployees(query), {
    query: employeeListQuery,
  })
  // ปีบัญชีที่มีอยู่จริงในทะเบียน — ไม่มี query เพราะไม่มีอะไรให้ค้น/กรอง คืนครบทีเดียว
  .get('/fiscal-years', () => masterService.findFiscalYears());

/**
 * ห้องพร้อมขอบเขตบนผังชั้น (0022) — **เปิดสาธารณะ ไม่อยู่หลัง authGuard**
 *
 * ★ ย้ายออกมาจากชุดที่มี guard เพราะหน้าปลายทางของ QR (/assets/:company/:number)
 *   วาดผังบอกที่ตั้งด้วย AppAssetDetail ตัวเดียวกับในแอป และหน้านั้นเปิดโดยไม่ล็อกอิน
 *   ถ้าเส้นนี้ยังอยู่หลัง guard คนที่สแกนสติกเกอร์จะได้ 401 แล้ว httpClient ฝั่งจอ
 *   เด้งไป /login ทันที = อาการ "สแกน QR แล้วติด authen" กลับมาทั้งดุ้น
 *
 * ★ สิ่งที่ปล่อยออกไปคือ "ชื่อห้องกับรูปร่างห้องบนผัง" ไม่ใช่ของในห้อง — ของที่ตั้งอยู่
 *   ในห้องยังต้องถามผ่าน /assets/by-room ซึ่งอยู่หลัง guard เหมือนเดิม
 *   (ตรงกับที่ตัดสินใจไว้ว่าหน้า QR ให้ดูได้หมดแต่แก้อะไรไม่ได้)
 *
 * ★ ต้อง .use() ก่อน masterRoutes ใน app.ts — ทั้งคู่ prefix '/master' เหมือนกัน
 */
export const masterPublicRoutes = new Elysia({ prefix: '/master' }).get('/floor-plans', () =>
  masterService.findFloorPlans(),
);
