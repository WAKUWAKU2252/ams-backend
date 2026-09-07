import { t } from 'elysia';
import { paginationQuery } from '@common/pagination';

export const poNumberParams = t.Object({
  poNumber: t.String({ minLength: 1, maxLength: 50 }),
});

// list แบบเบา (ไม่มี items) รองรับ search + pagination — ใช้กับหน้า autocomplete
// และตารางเลือก PO ในกล่อง Create New Request
export const poListQuery = t.Composite([
  paginationQuery,
  t.Object({
    search: t.Optional(t.String({ maxLength: 100 })),
    /**
     * กรองตามบริษัทเจ้าของใบ — ตั้งแต่ 0021 ตารางนี้ถือใบของทุกบริษัทปนกัน
     *
     * ไม่ใส่ = เห็นทุกบริษัท (พฤติกรรมเดิม ห้ามเปลี่ยนเป็นบังคับ — หน้า autocomplete
     * เดิมยิงมาโดยไม่มีพารามิเตอร์นี้ และยังต้องได้ผลเหมือนเดิมทุกประการ)
     */
    companyCode: t.Optional(t.String({ maxLength: 20 })),
    /**
     * ลำดับตามวันที่ของใบ — ค่าตั้งต้นคือใหม่สุดก่อน (ตรงกับพฤติกรรมเดิมก่อนมีพารามิเตอร์นี้)
     *
     * รับเฉพาะสองค่านี้ ไม่เปิดให้ส่งชื่อคอลัมน์มาเอง — ค่าที่หลุดเข้าไปใน ORDER BY
     * เป็นทางเข้าของ SQL injection ที่ ORM ปิดให้ไม่ได้
     */
    sort: t.Optional(t.Union([t.Literal('date_desc'), t.Literal('date_asc')])),
  }),
]);