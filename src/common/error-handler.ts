import { Elysia } from 'elysia';
import { AppError } from './errors';

// ที่เดียวที่แปลง error เป็น HTTP response
// รูปแบบ { message } ต้องคงไว้ — httpClient.ts ฝั่ง Vue อ่าน field นี้
export const errorHandler = new Elysia({ name: 'error-handler' }).onError(
  { as: 'global' },
  ({ error, code, set }) => {
    if (error instanceof AppError) {
      set.status = error.statusCode;
      return { message: error.message };
    }

    if (code === 'VALIDATION') {
      set.status = 400;
      return { message: error.message };
    }

    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { message: 'Route not found' };
    }

    console.error(error);
    set.status = 500;
    return { message: 'Internal server error' };
  },
);
