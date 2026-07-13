import { t } from 'elysia';

export const poNumberParams = t.Object({
  poNumber: t.String({ minLength: 1, maxLength: 50 }),
});
