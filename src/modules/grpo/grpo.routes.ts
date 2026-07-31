// ท่อบาง ๆ: แกะของจาก request -> เรียก service -> ส่งของกลับ
// ห้ามมี logic / ห้าม try-catch (error-handler แปลง AppError ให้เอง) / ห้าม query DB
import { Elysia } from 'elysia';
import { grpoIdParams, grpoListQuery, linkInvoiceBody } from './grpo.schema';
import * as grpoService from './grpo.service';
import { authGuard } from '../../plugins/auth';

export const grpoRoutes = new Elysia({ prefix: '/grpo' })
  .use(authGuard)
  .get('/', ({ query }) => grpoService.findByPo(query.poNumber ?? ''), { query: grpoListQuery })
  .get('/:id', ({ params }) => grpoService.findOneOrFail(params.id), { params: grpoIdParams })
  .patch('/:id/invoice', ({ params, body }) => grpoService.linkInvoice(params.id, body.attachmentId), {
    params: grpoIdParams,
    body: linkInvoiceBody,
  })
  .delete('/:id/invoice', ({ params }) => grpoService.unlinkInvoice(params.id), {
    params: grpoIdParams,
  });
