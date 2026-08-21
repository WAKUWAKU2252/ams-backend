// ประตูตรวจ request ของ auth — request ที่ผิดฟอร์มโดน 422 ตั้งแต่ตรงนี้
import { t } from 'elysia';

export const loginBody = t.Object({
  username: t.String({ minLength: 1, maxLength: 100 }),
  password: t.String({ minLength: 1 }),
});
