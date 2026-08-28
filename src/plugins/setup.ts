import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { env } from '@config/env';
import { errorHandler } from '@common/error-handler';

// cross-cutting ทั้งหมดของแอป รวมที่เดียว: CORS + Swagger (/swagger) + error handler
export const setup = new Elysia({ name: 'setup' })
  // ★ maxAge ต้องตั้งเอง — default ของปลั๊กอินคือ 5 วินาที ซึ่งสั้นกว่าจังหวะ retry ของสาย SSE
  //   (backoff 1–10 วิ) แปลว่าแทบทุกครั้งที่ต่อสายใหม่ต้องยิง OPTIONS ก่อนอีกรอบ = กิน
  //   socket สองช่องต่อการต่อหนึ่งครั้ง ทั้งที่คำตอบ preflight ไม่เคยเปลี่ยน
  //   เบราว์เซอร์ตัดให้เหลือเพดานของตัวเองอยู่แล้ว (Chrome 2 ชม.) ตั้งสูงกว่านั้นได้ไม่มีผลเสีย
  .use(cors({ origin: env.CORS_ORIGIN, credentials: true, maxAge: 86400 }))
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
