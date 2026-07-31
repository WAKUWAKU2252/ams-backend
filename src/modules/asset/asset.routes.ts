// ท่อบาง ๆ: แกะของจาก request -> เรียก service -> ส่งของกลับ
// ห้ามมี logic / ห้าม try-catch (error-handler แปลง AppError ให้เอง) / ห้าม query DB
import { Elysia } from 'elysia';
import { assetIdParams, assetListQuery, createAssetBody, updateAssetBody } from './asset.schema';
import * as assetService from './asset.service';
import { authGuard } from '../../plugins/auth';

export const assetRoutes = new Elysia({ prefix: '/assets' })
  .use(authGuard)
  // หน้าฟอร์มลงทะเบียนเรียกเส้นนี้เส้นเดียวก็เรนเดอร์ได้ทั้งหน้า (ช่อง + สถานะ + รอบรับของ)
  .get('/', ({ query }) => assetService.findSlotsByRequest(query.requestId), {
    query: assetListQuery,
  })
  .get('/:id', ({ params }) => assetService.findOneOrFail(params.id), { params: assetIdParams })
  .post('/', ({ body, currentUser }) => assetService.create(body, currentUser.id), {
    body: createAssetBody,
  })
  .patch('/:id', ({ params, body, currentUser }) => assetService.update(params.id, body, currentUser.id), {
    params: assetIdParams,
    body: updateAssetBody,
  })
  .delete('/:id', ({ params, currentUser }) => assetService.softDelete(params.id, currentUser.id), {
    params: assetIdParams,
  });
