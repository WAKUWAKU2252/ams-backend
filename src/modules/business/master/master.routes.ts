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
