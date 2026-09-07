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
      const details = error.all
        .map((e) => {
          const field = 'path' in e && e.path ? `${e.path.slice(1)}: ` : '';
          const schema =
            'schema' in e
              ? (e.schema as { anyOf?: { const?: unknown }[]; error?: unknown })
              : undefined;

          // ★ schema ที่เขียนข้อความเองไว้ ชนะ summary ของ TypeBox เสมอ
          //   จำเป็นกับ t.Union: summary มาตรฐานคือ "Value should be one of 'object', 'object'"
          //   ซึ่งไม่บอกอะไรเลยว่าผิดตรงไหน (ทั้งสองรูปเป็น object เหมือนกัน) — ดู createAssetBody
          if (typeof schema?.error === 'string') return `${field}${schema.error}`;

          const anyOf = schema?.anyOf;
          if (anyOf && anyOf.length > 0 && anyOf.every((s) => s.const !== undefined)) {
            return `${field}must be one of: ${anyOf.map((s) => s.const).join(', ')}`;
          }
          return `${field}${e.summary}`;
        })
        .join('; ');
      return { message: details || 'Validation failed' };
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
