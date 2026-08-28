// ประตูตรวจ request — ผิดฟอร์มโดน 422 ตั้งแต่ตรงนี้ service ไม่ต้องกันเอง
import { t } from 'elysia';

/**
 * departmentId เป็นแค่ "คำขอ" ไม่ใช่คำสั่ง — role ที่ไม่มีสิทธิ์ดูข้ามแผนกจะถูกทิ้งค่านี้
 * แล้วบังคับเป็นแผนกตัวเองใน resolveScope (ดู dashboard.service.ts)
 *
 * ไม่มี fiscalYear ให้เลือก: ตาราง asset_accounting เก็บ 1 แถวต่อชิ้น = ปีล่าสุดที่ SAP มี
 * ให้ชิ้นนั้นเท่านั้น ไม่มีข้อมูลย้อนหลังให้เลือกดู (แผนเก็บรายปีอยู่ในเฟสถัดไป)
 */
export const dashboardOverviewQuery = t.Object({
  departmentId: t.Optional(t.Numeric({ minimum: 1 })),
  /**
   * รหัสบริษัท — ตรวจว่ามีอยู่จริงที่ service (ต้อง query ตาราง company) ที่นี่ตรวจได้แค่ฟอร์ม
   * ความยาวตรงกับ company.code varchar(20)
   */
  companyCode: t.Optional(t.String({ minLength: 1, maxLength: 20 })),
});
