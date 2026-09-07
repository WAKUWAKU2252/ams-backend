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

/**
 * สถานที่ทางบัญชีใน dropdown — มี outPlan ติดมาด้วยเพราะฟอร์มต้องรู้ตั้งแต่ตอนเลือก
 *
 * ถ้าไม่ส่งมา ฝั่งจอจะบังคับให้เลือกห้อง+ปักหมุดกับทุกสถานที่เท่ากันหมด รวมถึงสถานที่ที่
 * ไม่มีวันมีห้องอยู่บนผังนี้ (ต่างประเทศ/สาขาอื่น) แล้วผู้ใช้จะบันทึกไม่ได้เลยโดยไม่มีทางออก
 */
export interface LocationOption extends MasterOption {
  /** true = ของอยู่นอกผังของไซต์นี้ ไม่ต้องเลือกห้องและไม่ต้องปักหมุด (ดู asset_location.outPlan) */
  outPlan: boolean;
}

export interface DepartmentOption extends MasterOption {
  /** ชื่อย่อไว้โชว์ในที่แคบ เช่น badge ในตาราง */
  shortName: string | null;
  /**
   * บริษัทเจ้าของแผนก (0024)
   *
   * ★ ต้องส่งออกไปด้วย เพราะตั้งแต่ 0024 **ชื่อแผนกซ้ำกันข้ามบริษัทได้จริง** — MIG กับ UBA
   *   มีชื่อตรงกันเป๊ะ 18 ชื่อ (Information Technology / Human Resources / Finance ...)
   *   dropdown ที่โชว์แต่ชื่อจะมีตัวเลือกหน้าตาเหมือนกันสองอันโดยที่คนเลือกแยกไม่ออก
   *   ฝั่งที่เรียกต้องกรองด้วยค่านี้ หรือแสดงรหัสบริษัทกำกับไว้
   */
  companyCode: string;
}

/**
 * บริษัทในเครือที่ใช้เป็นตัวกรองได้ (0024/0021)
 *
 * ★ ไม่ extends MasterOption — คีย์ของบริษัทคือ `code` ('UBA') ไม่ใช่ id ที่เดินเลขเอง
 *   ทุกตารางที่อ้างบริษัทถือ companyCode เป็น FK (asset / department / sap_*_sync)
 *   ยัด id ปลอมให้เข้ารูป { id, name } จะทำให้ฝั่งจอต้องแปลงกลับไปมาโดยไม่ได้อะไรเพิ่ม
 */
export interface CompanyOption {
  code: string;
  name: string;
}

/**
 * ชั้น/ห้อง — ตารางไม่มีคอลัมน์ name มีแค่ floor กับ room แยกกัน (ดู asset_sub_location)
 * จึงต้องประกอบ name ฝั่ง service ไม่ใช่ปล่อยให้แต่ละหน้าประกอบเอง (กติกาเดียวกับ employee)
 */
export interface SubLocationOption extends MasterOption {
  /** ให้ frontend กรองตามสถานที่ที่เลือกไว้ได้โดยไม่ต้องยิงซ้ำ (เหมือน EmployeeOption.departmentId) */
  locationId: number;
}

/**
 * ห้องบนผังชั้น — แยกจาก SubLocationOption คนละเส้นโดยตั้งใจ
 *
 * polygon แถวละ 4+ จุด คูณ 57 ห้อง ใหญ่กว่า payload ของ dropdown หลายเท่า และหน้าที่
 * ใช้ dropdown (ฟอร์ม asset) ไม่เคยต้องใช้ขอบเขตห้องเลย ถ้ายัดรวมกันทุกฟอร์มในระบบ
 * จะโหลดพิกัดผังติดไปด้วยทุกครั้งโดยไม่ได้ใช้
 */
export interface FloorPlanRoom {
  id: number;
  /** คีย์ธรรมชาติของห้อง เช่น B102-INV-01 — ใช้เป็น key ตอน render ไม่ใช่ id ที่ต่างกันตามเครื่อง */
  code: string;
  /** ชื่อที่ประกอบแล้วแบบเดียวกับ dropdown (subLocationName) — ต้องตรงกันไม่งั้นผู้ใช้สับสน */
  name: string;
  /** ชื่อห้องดิบ ๆ ไว้โชว์บนแผนที่ตอนซูมเข้า — ไม่เอา "ชั้น x / ห้อง" มาซ้ำในกรอบเล็ก ๆ */
  room: string | null;
  /** ชั้นของห้องนี้ — ซ้ำกับ FloorPlan.floor ที่ครอบอยู่ แต่ติดมากับห้องด้วยเพื่อให้ห้องที่
   *  ถูกส่งเดี่ยว ๆ (เช่นห้องที่ฟอร์มถืออยู่) บอกชั้นตัวเองได้โดยไม่ต้องย้อนหา plan */
  floor: string | null;
  locationId: number;
  /** ชื่อตึก ไว้จัดกลุ่มในลิสต์ข้างแผนที่ (ตึกคือ asset_location คนละแถว ดู 0022) */
  locationName: string;
  /** ขอบเขตห้อง [[x,y],...] สัดส่วน 0–1 ของภาพผัง — คูณกับขนาดที่เรนเดอร์จริงฝั่งจอ */
  polygon: [number, number][];
}

/** ผังหนึ่งใบ = หนึ่งชั้นของทั้งไซต์ ไฟล์ภาพอยู่ฝั่ง frontend ที่ /floorplans/<planKey>.png */
export interface FloorPlan {
  planKey: string;
  /** ชั้นที่ผังใบนี้แทน — ห้องทุกห้องบนผังใบเดียวกันอยู่ชั้นเดียวกัน */
  floor: string | null;
  rooms: FloorPlanRoom[];
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
