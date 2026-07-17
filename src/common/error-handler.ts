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
      // error.message ของ ValidationError เป็น JSON debug dump ทั้งก้อน — ห้ามส่งตรง
      // สรุปจาก error.all เป็น "field: เหตุผล" ให้ client อ่านรู้เรื่องแทน
      const details = error.all
        .map((e) => {
          const field = 'path' in e && e.path ? `${e.path.slice(1)}: ` : '';
          // union ของ literal (เช่น enum status): summary ของ TypeBox บอกแค่ชนิด
          // ("one of: 'string', 'string'") — แจงค่าที่ยอมรับจริงจาก anyOf แทน
          const anyOf =
            'schema' in e ? (e.schema as { anyOf?: { const?: unknown }[] }).anyOf : undefined;
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
