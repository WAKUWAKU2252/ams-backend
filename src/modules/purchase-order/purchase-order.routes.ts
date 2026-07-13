import { Elysia } from 'elysia';
import { poNumberParams } from './purchase-order.schema';
import * as poService from './purchase-order.service';

export const purchaseOrderRoutes = new Elysia({ prefix: '/purchase-orders' })
  .get('/', () => poService.findAll())
  .get('/:poNumber', ({ params }) => poService.findOneOrFail(params.poNumber), {
    params: poNumberParams,
  });
