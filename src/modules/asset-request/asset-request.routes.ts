import { Elysia } from 'elysia';
import { createDraftBody, requestIdParams, listQuery } from './asset-request.schema';
import * as assetRequestService from './asset-request.service';

export const assetRequestRoutes = new Elysia({ prefix: '/asset-requests' })
  .post('/', ({ body }) => assetRequestService.createDraft(body.poNumber, body.createBy), {
    body: createDraftBody,
  })
  .get('/', ({ query }) => assetRequestService.listMyDrafts(query), { query: listQuery })
  .get('/:id', ({ params }) => assetRequestService.getDraftOrFail(params.id), {
    params: requestIdParams,
  });