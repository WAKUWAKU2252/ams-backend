import { Elysia } from 'elysia';
import { jwt } from '@elysiajs/jwt';
import { env } from '../config/env';
import { UnauthorizedError, ForbiddenError } from '../common/errors';

// sign/verify JWT — ตั้ง secret + อายุ token ที่เดียว (ยังไม่ทำ refresh token ระยะนี้)
export const jwtPlugin = jwt({
  name: 'jwt',
  secret: env.JWT_SECRET,
  exp: env.JWT_EXPIRES_IN,
});

export const authGuard = new Elysia({ name: 'authGuard' })
  .use(jwtPlugin)
  .derive({ as: 'scoped' }, async ({ jwt, headers }) => {
    const header = headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedError();

    const payload = await jwt.verify(token);
    if (!payload || typeof payload.sub !== 'string') {
      throw new UnauthorizedError('token ไม่ถูกต้องหรือหมดอายุ');
    }

    return {
      currentUser: {
        id: Number(payload.sub),
        role: String(payload.role)
      },
    };
  });

// requireRole('MANAGER', 'FINANCE') — บังคับ role ต่อจาก authGuard
// ใช้: new Elysia().use(requireRole('FINANCE')).get(...)  → 401 ถ้าไม่ล็อกอิน, 403 ถ้า role ไม่ตรง
export const requireRole = (...roles: string[]) =>
  new Elysia()
    .use(authGuard)
    .onBeforeHandle({ as: 'scoped' }, ({ currentUser }) => {
      if (!currentUser) throw new UnauthorizedError();
      if (!roles.includes(currentUser.role)) throw new ForbiddenError();
    });
