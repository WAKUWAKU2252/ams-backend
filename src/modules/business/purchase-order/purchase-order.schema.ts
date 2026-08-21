import { t } from 'elysia';
import { paginationQuery } from '@common/pagination';

export const poNumberParams = t.Object({
  poNumber: t.String({ minLength: 1, maxLength: 50 }),
});

// list แบบเบา (ไม่มี items) รองรับ search + pagination — ใช้กับหน้า autocomplete
export const poListQuery = t.Composite([
  paginationQuery,
  t.Object({ search: t.Optional(t.String({ maxLength: 100 })) }),
]);