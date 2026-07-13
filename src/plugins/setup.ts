import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { env } from '../config/env';
import { errorHandler } from '../common/error-handler';

// cross-cutting ทั้งหมดของแอป รวมที่เดียว: CORS + Swagger (/swagger) + error handler
export const setup = new Elysia({ name: 'setup' })
  .use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
  .use(swagger())
  .use(errorHandler);
