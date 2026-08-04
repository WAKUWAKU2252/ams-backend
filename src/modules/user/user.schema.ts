// ประตูตรวจ request ของ user — ผิดฟอร์มโดน 422 ตั้งแต่ตรงนี้
import { t } from 'elysia';

export const createUserBody = t.Object({
  username: t.String({ minLength: 1, maxLength: 100 }),
  email: t.Optional(t.String({ format: 'email', maxLength: 100 })),
  displayName: t.String({ minLength: 1, maxLength: 100 }),
  // แยกชื่อ-นามสกุล (nullable ใน DB) — ส่งมาก็เก็บ ไม่ส่งก็เป็น null
  firstName: t.Optional(t.String({ maxLength: 100 })),
  lastName: t.Optional(t.String({ maxLength: 100 })),
  password: t.String({ minLength: 4 }),
  // FK ไป role — ต้องมีอยู่จริง (EMPLOYEE/MANAGER/FINANCE); 0 ไม่ผ่าน
  roleId: t.Integer({ minimum: 1 }),
  // ว่างได้ — บาง account ไม่ผูกกับพนักงาน HR (เช่น service account)
  employeeId: t.Optional(t.Union([t.Integer({ minimum: 1 }), t.Null()])),
});
