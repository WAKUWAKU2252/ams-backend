import { t } from 'elysia';

// ใช้กับ endpoint ที่รองรับ ?page=&limit= เช่น { query: paginationQuery }
export const paginationQuery = t.Object({
  page: t.Number({ minimum: 1, default: 1 }),
  limit: t.Number({ minimum: 1, maximum: 100, default: 20 }),
});

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

export function paginate<T>(data: T[], total: number, page: number, limit: number): Paginated<T> {
  return { data, total, page, limit };
}
