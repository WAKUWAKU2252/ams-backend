// ประตูตรวจ request ของ user — ผิดฟอร์มโดน 422 ตั้งแต่ตรงนี้
import { t } from 'elysia';

export const createUserBody = t.Object({
  username: t.String({ minLength: 1, maxLength: 100 }),
  // ไม่รับ email แล้ว (0005) — แหล่งเดียวคือ employee.email ที่มาจาก HR/SAP
  // อยากให้ user มีอีเมล ให้ผูก employeeId แล้วแก้ที่ employee ไม่ใช่ส่งมาที่นี่
  displayName: t.String({ minLength: 1, maxLength: 100 }),
  // ไม่รับ firstName/lastName แล้ว — ชื่อจริงเป็นของ employee (มาจาก SAP/HR)
  // ถ้าต้องการชื่อจริงให้ผูก employeeId แล้ว join เอา
  password: t.String({ minLength: 4 }),
  // FK ไป role — ต้องมีอยู่จริง (EMPLOYEE/MANAGER/FINANCE/ADMIN); 0 ไม่ผ่าน
  roleId: t.Integer({ minimum: 1 }),
  // ว่างได้ — บาง account ไม่ผูกกับพนักงาน HR (เช่น service account)
  employeeId: t.Optional(t.Union([t.Integer({ minimum: 1 }), t.Null()])),

  /**
   * สร้างพนักงานใหม่ไปพร้อมกันในคำสั่งเดียว — ใช้แทน employeeId (ส่งพร้อมกันไม่ได้)
   *
   * ปกติข้อมูลพนักงานมาจาก HR/SAP ผ่านสคริปต์ import ช่องนี้เป็นทางลัดของแอดมินสำหรับคน
   * ที่ยังไม่มีในต้นทาง (พนักงานใหม่ที่ HR ยังไม่ส่งไฟล์มา) — ไม่ใช่ทางเข้าปกติ
   *
   * ⚠️ ที่กรอกที่นี่จะถูก sync ทับเมื่อไหร่ก็ได้ถ้าคนคนนั้นโผล่มาใน SAP ทีหลังด้วย
   * ownerCode เดียวกัน — ให้ถือว่าเป็นข้อมูลชั่วคราวจนกว่า HR จะส่งของจริงมา
   */
  employee: t.Optional(
    t.Object({
      // ทุกช่องยกเว้น departmentId เป็น nullable ที่ DB (ข้อมูล HR จริงไม่ครบทุกคน)
      // แต่ที่นี่บังคับชื่อไทยอย่างน้อยหนึ่งช่อง ไม่งั้นสร้างคนที่ไม่มีชื่อให้เรียกเลย
      firstName: t.String({ minLength: 1, maxLength: 100 }),
      lastName: t.Optional(t.String({ maxLength: 100 })),
      firstNameEn: t.Optional(t.String({ maxLength: 100 })),
      lastNameEn: t.Optional(t.String({ maxLength: 100 })),
      // รหัสพนักงานจาก HR — varchar ไม่ใช่ integer (มีคนที่รหัสเป็นตัวอักษรผสม เช่น KTP1)
      empId: t.Optional(t.String({ maxLength: 20 })),
      // ปลายทางของอีเมลแจ้งผลทั้งระบบ — ไม่กรอกก็สร้างได้ แต่คนนั้นจะไม่ได้รับอีเมลใด ๆ
      email: t.Optional(t.String({ maxLength: 100 })),
      // รหัสที่ SAP ใช้อ้างผู้ขอบน PO (OPOR.OwnerCode) — ใส่ได้ถ้ารู้ ไม่รู้ก็เว้น
      ownerCode: t.Optional(t.Integer({ minimum: 1 })),
      // NOT NULL ที่ DB — พนักงานต้องสังกัดแผนกเสมอ
      departmentId: t.Integer({ minimum: 1 }),
    }),
  ),
});
