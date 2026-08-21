// ประตูตรวจ request — request ที่ผิดฟอร์มโดน 422 ตั้งแต่ตรงนี้ service ไม่ต้องกันเอง
//
// ไม่มี pagination โดยตั้งใจ: master table มีหลักสิบแถว dropdown ต้องได้ครบทีเดียว
// ถ้าแบ่งหน้า ผู้ใช้จะเลือกตัวเลือกที่อยู่หน้า 2 ไม่ได้เลย
// ข้อยกเว้นคือ employee ซึ่งใหญ่ระดับทั้งบริษัท — ดู employeeListQuery
import { t } from 'elysia';
import { paginationQuery } from '@common/pagination';

/** ใช้ร่วมกับทุก master ที่มี isActive (department, category, uom, location) */
export const masterListQuery = t.Object({
  search: t.Optional(t.String({ maxLength: 100 })),
  // กติกาของ master table คือ isActive แทนการลบ (ดูหัวไฟล์ schema/tables/business/master.ts)
  // ฟอร์มสร้างใหม่ต้องเห็นเฉพาะที่เปิดใช้ ส่วนฟอร์มแก้ของเก่าต้องเห็นค่าที่เคยเลือกไว้ด้วย
  // ไม่งั้น dropdown จะเด้งเป็นว่างทั้งที่ในฐานข้อมูลมีค่าอยู่
  includeInactive: t.Optional(t.Boolean({ default: false })),
});

// employee ต่างจาก master ตัวอื่นตรงที่ใหญ่ระดับทั้งบริษัท — UI เป็นลิสต์ให้เลื่อนดู
// พร้อมพิมพ์ค้น จึงแบ่งหน้าแทนการคืนทั้งก้อน (ตัวอื่นคืนครบเพราะหลักสิบแถว)
// paginationQuery มี default page=1 limit=20 มาให้แล้ว
export const employeeListQuery = t.Composite([
  masterListQuery,
  paginationQuery,
  t.Object({
    departmentId: t.Optional(t.Numeric({ minimum: 1 })),
    // ค้นด้วย id ตรง ๆ — ใช้ตอนฟอร์มแก้ไขต้องแปลง employeeId ที่บันทึกไว้กลับเป็นชื่อ
    // ไม่มีตัวนี้ dropdown จะโชว์ค่าว่างทั้งที่ในฐานข้อมูลมีผู้ถือครองอยู่
    // (คู่กับ includeInactive: คนที่ลาออกแล้วก็ยังต้องรู้ชื่อว่าเคยถือครองอะไรอยู่)
    id: t.Optional(t.Numeric({ minimum: 1 })),
  }),
]);
