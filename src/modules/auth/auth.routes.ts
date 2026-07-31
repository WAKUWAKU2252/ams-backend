// ท่อบาง ๆ: แกะ request -> เรียก service -> ส่งกลับ (ห้าม logic/try-catch/query DB)
import { Elysia } from 'elysia';
import { jwtPlugin, authGuard } from '../../plugins/auth';
import { loginBody } from './auth.schema';
import * as authService from './auth.service';

// public — ไม่ต้องมี token (แยก instance กัน authGuard มาบังคับ /login)
const publicRoutes = new Elysia().use(jwtPlugin)
.post('/login', async ({ body, jwt }) => {
    const user = await authService.verifyCredentials(body);
    const token = await jwt.sign({ sub: String(user.id), role: user.role.name });
    
    return { token, user };
  },
  { body: loginBody },
);



const protectedRoutes = new Elysia()
  .use(authGuard)
  .get('/me', ({ currentUser }) => authService.getMe(currentUser.id));

export const authRoutes = new Elysia({ prefix: '/auth' })
  .use(publicRoutes)
  .use(protectedRoutes);
