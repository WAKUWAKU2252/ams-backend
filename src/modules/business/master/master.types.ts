// สัญญาชนิดข้อมูลของโมดูล master — ไฟล์นี้ไม่มี logic และไม่ import service
//
// ชนิดที่ "มีอยู่แล้วในตาราง" derive จาก schema เสมอ ไม่พิมพ์ซ้ำด้วยมือ —
// คอลัมน์เปลี่ยนชนิดเมื่อไหร่ ที่นี่เปลี่ยนตาม แล้ว compiler จะชี้จุดที่ต้องแก้ให้เอง
import type {
  assetLocation,
  assetSubLocation,
  category,
  department,
  employee,
} from '@intrastucture/db/schema';

export type DepartmentRow = typeof department.$inferSelect;
export type EmployeeRow = typeof employee.$inferSelect;
export type CategoryRow = typeof category.$inferSelect;
// ไม่มี UomRow — ตาราง uom ถูกถอดใน 0011 หน่วยนับเป็นคอลัมน์ asset.uom แล้ว
export type LocationRow = typeof assetLocation.$inferSelect;
export type SubLocationRow = typeof assetSubLocation.$inferSelect;

// ── หน้าตาที่ส่งออก API ────────────────────────────────────────────────────
// ทุก endpoint คืนรูปเดียวกัน { id, name } เพื่อให้ฝั่ง frontend ใช้ component
// dropdown ตัวเดียวกับทุก master ได้ ไม่ต้องเขียน mapper แยกต่อตาราง
//
// ส่งเฉพาะที่ dropdown ใช้จริง ไม่ส่งทั้งแถว: คีย์ภายในของ HR/SAP (empId, ownerCode,
// department.departmentId) และข้อมูลส่วนบุคคล (email) ไม่ควรหลุดออก API ที่ทุก role
// ที่ล็อกอินเรียกได้ — และพอ endpoint คืนอะไรไปแล้ว frontend จะเริ่มพึ่งมัน ถอดออกทีหลังยาก

export interface MasterOption {
  id: number;
  name: string;
}

export interface DepartmentOption extends MasterOption {
  /** ชื่อย่อไว้โชว์ในที่แคบ เช่น badge ในตาราง */
  shortName: string | null;
}

/**
 * ชั้น/ห้อง — ตารางไม่มีคอลัมน์ name มีแค่ floor กับ room แยกกัน (ดู asset_sub_location)
 * จึงต้องประกอบ name ฝั่ง service ไม่ใช่ปล่อยให้แต่ละหน้าประกอบเอง (กติกาเดียวกับ employee)
 */
export interface SubLocationOption extends MasterOption {
  /** ให้ frontend กรองตามสถานที่ที่เลือกไว้ได้โดยไม่ต้องยิงซ้ำ (เหมือน EmployeeOption.departmentId) */
  locationId: number;
}

export interface EmployeeOption extends MasterOption {
  /** ให้ฝั่ง frontend กรองรายชื่อตามแผนกที่เลือกไว้ได้โดยไม่ต้องยิงซ้ำ */
  departmentId: number;
  /**
   * รหัสพนักงานจาก HR — คนละตัวกับ id ของตาราง
   *
   * string ไม่ใช่ number: คอลัมน์เป็น varchar(20) เพราะข้อมูลจริงจาก HR ไม่ได้เป็นเลข
   * ล้วนเสมอ (แก้ชนิดไปแล้วใน migration 0006) และ null ได้เพราะบางแถวยังไม่มีรหัส
   */
  empId: string | null;
}

// ── input ของ service ──────────────────────────────────────────────────────

export interface MasterListInput {
  search?: string;
  /** true = เอาแถวที่ปิดใช้งานแล้วมาด้วย (หน้าแก้ของเก่าต้องเห็นค่าที่เคยเลือกไว้) */
  includeInactive?: boolean;
}

/** employee แบ่งหน้า — page/limit มี default มาจาก paginationQuery แล้ว จึงเป็น required ที่นี่ */
export interface EmployeeListInput extends MasterListInput {
  departmentId?: number;
  /** ค้นคนเดียวด้วย id — ฟอร์มแก้ไขใช้แปลง employeeId ที่บันทึกไว้กลับเป็นชื่อ */
  id?: number;
  page: number;
  limit: number;
}
