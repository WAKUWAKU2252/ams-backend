import { Elysia } from 'elysia';
import { setup } from './plugins/setup';
import { purchaseOrderRoutes } from './modules/purchase-order';

// ประกอบ app ทั้งหมด — แยกจาก listen() เพื่อให้ test เรียก createApp().handle(...) ได้
export const createApp = () =>
  new Elysia()
    .use(setup)
    .get('/health', () => ({ status: 'ok' }))
    .use(purchaseOrderRoutes);
