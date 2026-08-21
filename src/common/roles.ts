// ชื่อ role ถูกอ้างเป็นสตริงตรง ๆ ทั่วโค้ด (requireRole('MANAGER') ฯลฯ)
// ค่าที่ใช้ได้ดูที่ db/import/role.ts ซึ่งเป็นแหล่งเดียวที่สร้างแถวในตาราง role

/**
 * role ที่อนุมัติ/ตีกลับคำขอลงทะเบียนได้
 *
 * ต้องเป็นชุดเดียวกันทั้งสามที่ ไม่งั้นระบบจะขัดกันเองแบบเงียบ ๆ:
 *   1. requireRole(...) ที่กั้น POST /asset-requests/:id/approve|reject  (อนุมัติผ่านหน้าเว็บ)
 *   2. findApprovalTarget() ตอนหา user ของหัวหน้า                        (ตัดสินว่าส่งใบให้ใครได้)
 *   3. resolveManagerUserId() ตอนรับผลกลับจาก Teams                      (อนุมัติผ่านการ์ด)
 *
 * เคยเป็น 'MANAGER' อย่างเดียวทั้งสามที่ — ถ้าปล่อยให้ต่างกัน จะเกิดเคสที่ส่งใบไปหาคนที่
 * กดอนุมัติไม่ได้ (หรือกลับกัน: กดผ่านหน้าเว็บได้แต่กดผ่าน Teams ไม่ได้)
 */
export const APPROVER_ROLES = ['MANAGER', 'FINANCE', 'ADMIN'] as const;

/** สำหรับส่งเข้า drizzle inArray() ซึ่งรับ readonly tuple ไม่ได้ */
export const APPROVER_ROLE_LIST: string[] = [...APPROVER_ROLES];

/**
 * role ที่ออกเลขสินทรัพย์ (ปิดงานหลังอนุมัติ) ได้
 *
 * แยกจาก APPROVER_ROLES โดยตั้งใจ ห้ามใช้ตัวนั้นซ้ำ — สองชุดนี้ตอบคนละคำถาม:
 *   APPROVER  = "ใครตัดสินว่าคำขอนี้สมควรได้รับอนุมัติ"   (หัวหน้าแผนกของผู้ขอ)
 *   REGISTRAR = "ใครมีเลขสินทรัพย์จาก SAP อยู่ในมือ"       (บัญชีเท่านั้น)
 *
 * MANAGER อนุมัติได้แต่ออกเลขไม่ได้ ถ้าเอาสองชุดมารวมกันเพราะ "ตอนนี้ค่าเหมือนกันเกือบหมด"
 * วันที่ต้องแยกจริงจะแยกไม่ออกแล้ว เพราะมีโค้ดหลายที่อ้างค่าเดียวกันด้วยเหตุผลคนละอย่าง
 */
export const REGISTRAR_ROLES = ['FINANCE', 'ADMIN'] as const;

/**
 * role ที่เห็นตัวเลขบน Dashboard ของ "ทุกแผนก"
 *
 * ค่าเท่ากับ APPROVER_ROLES ตอนนี้ แต่ห้ามใช้ตัวนั้นซ้ำด้วยเหตุผลเดียวกับ REGISTRAR_ROLES —
 * สองชุดตอบคนละคำถาม:
 *   APPROVER  = "ใครตัดสินว่าคำขอนี้สมควรได้รับอนุมัติ"
 *   DASHBOARD = "ใครดูมูลค่าทรัพย์สินของแผนกอื่นได้"
 *
 * ★ ชุดนี้คือ "ใครเห็นเงินของคนอื่น" ไม่ใช่แค่เรื่องความสะดวก — role ที่ไม่อยู่ในลิสต์
 *   จะถูกบังคับให้เห็นเฉพาะแผนกตัวเอง โดยที่ departmentId ที่ส่งมาใน query ถูกทิ้ง
 *   (ดู resolveScope) ไม่ใช่แค่ซ่อน dropdown ฝั่งหน้าจอ
 */
export const DASHBOARD_ALL_DEPARTMENT_ROLES = ['MANAGER', 'FINANCE', 'ADMIN'] as const;

/** สำหรับเช็คด้วย .includes() ซึ่งรับ readonly tuple ของ literal ไม่ได้ */
export const DASHBOARD_ALL_DEPARTMENT_ROLE_LIST: string[] = [...DASHBOARD_ALL_DEPARTMENT_ROLES];
