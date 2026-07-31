import { Elysia } from 'elysia';
import { poListQuery, poNumberParams } from './purchase-order.schema';
import * as poService from './purchase-order.service';
import { authGuard } from '../../plugins/auth';

export const purchaseOrderRoutes = new Elysia({ prefix: '/purchase-orders' })
  .use(authGuard)
  .get('/', ({ query }) => poService.findPage(query), { query: poListQuery })
  .get('/:poNumber', ({ params }) => poService.findOneOrFail(params.poNumber), {
    params: poNumberParams,
  })
