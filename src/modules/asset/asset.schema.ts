// ประตูตรวจ request — request ที่ผิดฟอร์มโดน 422 ตั้งแต่ตรงนี้ service ไม่ต้องกันเอง
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

  // id จาก POST /uploads — ไม่รับไฟล์ตรงนี้
  imageId: t.Optional(t.String({ format: 'uuid' })),

  // TODO(auth): ตัดออกแล้วอ่านจาก token แทน — ตอนนี้ client ส่งมาเองได้ซึ่งปลอมได้
  createdBy: t.String({ minLength: 1, maxLength: 100 }),
});

// แก้ได้เฉพาะข้อมูลของชิ้น — requestId/grpoLineId ย้ายไม่ได้ (ผิดชิ้นต้องลบแล้วสร้างใหม่)
export const updateAssetBody = t.Object({
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
  updatedBy: t.String({ minLength: 1, maxLength: 100 }),
});

export const deleteAssetBody = t.Object({
  deletedBy: t.String({ minLength: 1, maxLength: 100 }),
});
