// ประตูตรวจ request — request ที่ผิดฟอร์มโดน 422 ตั้งแต่ตรงนี้ service ไม่ต้องกันเอง
// ไม่มี createdBy/updatedBy/deletedBy: identity มาจาก token (currentUser.id) เท่านั้น
// ห้ามรับจาก body — ไม่งั้นคนที่ล็อกอินแล้วอ้างเป็นใครก็ได้ในประวัติสินทรัพย์
import { t } from 'elysia';

export const assetIdParams = t.Object({ id: t.Numeric() });

export const assetListQuery = t.Object({
  requestId: t.Numeric(),
});

export const createAssetBody = t.Object({
  requestId: t.Integer({ minimum: 1 }),
  // ชิ้นนี้มาจากรอบรับของไหน — ตัวนี้เองที่บังคับว่าลงทะเบียนได้เฉพาะของที่รับแล้ว
  grpoLineId: t.String({ format: 'uuid' }),

  description: t.Optional(t.String({ maxLength: 100 })),
  serialNumber: t.Optional(t.String({ maxLength: 100 })),
  assetClass: t.Optional(t.String({ maxLength: 50 })),

  categoryId: t.Integer({ minimum: 1 }),
  uomId: t.Integer({ minimum: 1 }),
  locationId: t.Integer({ minimum: 1 }),
  subLocationId: t.Optional(t.Integer({ minimum: 1 })),
  employeeId: t.Optional(t.Integer({ minimum: 1 })),

  warrantyStartDate: t.Optional(t.String()),
  warrantyEndDate: t.Optional(t.String()),

  // เลขช่องที่ผู้ใช้กรอก (ตรงกับที่เห็นบนฟอร์ม) — ไม่ส่งมาก็ต่อท้ายให้
  // ส่งมาแล้วชนกับที่มีอยู่ = 409 (unique ที่ DB เป็นคนตัดสิน ไม่ใช่การนับ)
  unitNo: t.Optional(t.Integer({ minimum: 1 })),
  // ราคาทุนที่เสนอ — ไม่ส่งมาใช้ unitPrice ของ PO line; งานเหมาที่แตกหลายชิ้นต้องส่งเอง
  acquisitionCost: t.Optional(t.Number({ minimum: 0 })),

  // id จาก POST /uploads — ไม่รับไฟล์ตรงนี้
  imageId: t.Optional(t.String({ format: 'uuid' })),
});

// แก้ได้เฉพาะข้อมูลของชิ้น — requestId ย้ายไม่ได้
// grpoLineId ย้ายได้ภายใน PO line เดียวกัน: งานเหมาที่ทยอยส่ง คนกรอกอาจผูกรอบผิดตอนแรก
// (ตอนนั้นมีรอบเดียว) การบังคับให้ลบแล้วสร้างใหม่คือการทิ้งข้อมูลที่กรอกไปแล้วโดยไม่จำเป็น
export const updateAssetBody = t.Object({
  grpoLineId: t.Optional(t.String({ format: 'uuid' })),
  acquisitionCost: t.Optional(t.Number({ minimum: 0 })),
  description: t.Optional(t.String({ maxLength: 100 })),
  serialNumber: t.Optional(t.String({ maxLength: 100 })),
  assetClass: t.Optional(t.String({ maxLength: 50 })),
  categoryId: t.Optional(t.Integer({ minimum: 1 })),
  uomId: t.Optional(t.Integer({ minimum: 1 })),
  locationId: t.Optional(t.Integer({ minimum: 1 })),
  subLocationId: t.Optional(t.Integer({ minimum: 1 })),
  employeeId: t.Optional(t.Integer({ minimum: 1 })),
  warrantyStartDate: t.Optional(t.String()),
  warrantyEndDate: t.Optional(t.String()),
  imageId: t.Optional(t.String({ format: 'uuid' })),
});
