import { Elysia } from 'elysia';
import { poListQuery, poNumberParams } from './purchase-order.schema';
import * as poService from './purchase-order.service';

export const purchaseOrderRoutes = new Elysia({ prefix: '/purchase-orders' })
  .get('/', ({ query }) => poService.findPage(query), { query: poListQuery })
  .get('/:poNumber', ({ params }) => poService.findOneOrFail(params.poNumber), {
    params: poNumberParams,
  })
  .get('/all',() => poService.findAll)
