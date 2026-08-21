import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { env } from '@config/env';
import { errorHandler } from '@common/error-handler';

// cross-cutting ทั้งหมดของแอป รวมที่เดียว: CORS + Swagger (/swagger) + error handler
export const setup = new Elysia({ name: 'setup' })
  .use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
  // ประกาศ bearer auth ให้ Swagger มีปุ่ม "Authorize" — แปะ token จาก POST /auth/login ทีเดียว
  // ใช้ได้ทุก endpoint (แค่ documentation UI ไม่ได้ลดการบังคับ auth จริงฝั่ง server)
  .use(
    swagger({
      documentation: {
        components: {
          securitySchemes: {
            bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    }),
  )
  .use(errorHandler);
