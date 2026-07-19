// ท่อบาง ๆ: แกะของจาก request -> เรียก service -> ส่งของกลับ
// ห้ามมี logic / ห้าม try-catch (error-handler แปลง AppError ให้เอง) / ห้าม query DB
import { Elysia } from 'elysia';
import {
  assetIdParams,
  assetListQuery,
  createAssetBody,
  updateAssetBody,
  deleteAssetBody,
} from './asset.schema';
import * as assetService from './asset.service';

export const assetRoutes = new Elysia({ prefix: '/assets' })
  // หน้าฟอร์มลงทะเบียนเรียกเส้นนี้เส้นเดียวก็เรนเดอร์ได้ทั้งหน้า (ช่อง + สถานะ + รอบรับของ)
  .get('/', ({ query }) => assetService.findSlotsByRequest(query.requestId), {
    query: assetListQuery,
  })
  .get('/:id', ({ params }) => assetService.findOneOrFail(params.id), { params: assetIdParams })
  .post('/', ({ body }) => assetService.create(body), { body: createAssetBody })
  .patch('/:id', ({ params, body }) => assetService.update(params.id, body), {
    params: assetIdParams,
    body: updateAssetBody,
  })
  .delete('/:id', ({ params, body }) => assetService.softDelete(params.id, body.deletedBy), {
    params: assetIdParams,
    body: deleteAssetBody,
  });
