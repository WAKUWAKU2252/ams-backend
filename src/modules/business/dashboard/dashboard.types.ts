// สัญญาชนิดข้อมูลของโมดูล dashboard — ไม่มี logic และไม่ import service (กัน import วน)
import type { asset } from '@intrastucture/db/schema';

export type AssetStatus = (typeof asset.$inferSelect)['status'];

/**
 * ขอบเขตที่ตัวเลขชุดนี้นับมาจาก — **backend เป็นคนตัดสิน ไม่ใช่ query ที่ส่งมา**
 *
 *   ALL           เห็นได้ทุกแผนก (ยังแคบลงได้ด้วย departmentId ที่ผู้ใช้เลือกเอง)
 *   OWN_DEPARTMENT ถูกล็อกไว้ที่แผนกตัวเอง — departmentId ที่ส่งมาถูกทิ้ง
 *   UNLINKED      บัญชีนี้ยังไม่ผูกกับพนักงาน จึงบอกไม่ได้ว่าอยู่แผนกไหน = ไม่มีอะไรให้นับ
 *
 * ★ UNLINKED ไม่ใช่ error และไม่ใช่ "ไม่มีของ" — เป็นปัญหาที่ต้องให้ผู้ดูแลระบบไปผูกให้
 *   ถ้าคืน 403 หรือคืนศูนย์เฉย ๆ ผู้ใช้จะไม่มีทางรู้ว่าต้องไปแก้ที่ไหน (หลักเดียวกับ
 *   linkedToEmployee ของ GET /assets/mine)
 */
export type DashboardScopeKind = 'ALL' | 'OWN_DEPARTMENT' | 'UNLINKED';

export interface DashboardScope {
  kind: DashboardScopeKind;
  /** แผนกที่ตัวเลขชุดนี้นับมาจริง ๆ — null = รวมทุกแผนก */
  departmentId: number | null;
  departmentName: string | null;
  /** true = หน้าจอต้องล็อกช่องเลือกแผนก (เลือกแผนกอื่นไปก็ไม่มีผล backend ทิ้งอยู่ดี) */
  locked: boolean;
}

export interface DashboardTotals {
  /** จำนวนชิ้นในทะเบียน (lifecycle = REGISTERED, ยังไม่ถูกลบ) */
  assets: number;
  /**
   * ชิ้นที่มีตัวเลขบัญชีครบพอจะเอาไปรวมเป็นเงินได้ (มีทั้งราคาทุนและค่าเสื่อมสะสม)
   *
   * ★ ยอดเงินทั้งสามก้อนข้างล่างนับจากชุดนี้ชุดเดียวกันหมด ไม่ใช่คนละชุด — เพื่อให้
   *   `ราคาทุน − ค่าเสื่อมสะสม = มูลค่าคงเหลือ` เป็นจริงบนหน้าจอเสมอ ถ้าปล่อยให้แต่ละก้อน
   *   นับจากชุดที่ตัวเองมีข้อมูล บัญชีจะบวกลบตามแล้วไม่ลงตัว แล้วอ่านเป็นบั๊กทันที
   */
  valued: number;
  /** ชิ้นที่ยังไม่มีตัวเลขบัญชีจาก SAP — ไม่ถูกนับในยอดเงิน ต้องบอกผู้ใช้ให้รู้ */
  unvalued: number;
  /** null = ไม่มีชิ้นไหนมีตัวเลขบัญชีเลย (ต่างจาก 0 ที่แปลว่ารวมแล้วได้ศูนย์จริง) */
  bookedCost: number | null;
  accumulatedDepreciation: number | null;
  netBookValue: number | null;
}

/**
 * ตัวเลขบัญชีเป็นของ "ปีบัญชีล่าสุดที่ SAP มีให้ชิ้นนั้น" ซึ่งไม่ใช่ปีปัจจุบันเสมอไป
 * (ของที่ตัดจำหน่าย/หยุดคิดค่าเสื่อมแล้วจะค้างที่ปีสุดท้ายของมัน — วัด 2026-08-20 ได้ 25%
 * ของทะเบียน) ยอดรวมจึงต้องมาคู่กับ "กี่ชิ้นที่เป็นตัวเลขของปีนี้จริง" เสมอ ไม่งั้นผู้ใช้
 * จะอ่านยอดที่มีเลขปี 2022 ปนอยู่เป็นมูลค่าของวันนี้
 */
export interface DashboardFreshness {
  /** ปีที่ใช้เป็นเกณฑ์ว่า "ปีปัจจุบัน" คือปีไหน */
  fiscalYear: number;
  currentYearCount: number;
  /** มีตัวเลขบัญชี แต่เป็นของปีเก่า */
  staleCount: number;
  /** ไม่มีแถวบัญชีเลย */
  noDataCount: number;
}

export interface StatusCount {
  status: AssetStatus;
  count: number;
}

export interface DashboardStatus {
  active: number;
  /** ทุกสถานะที่ไม่ใช่ Active รวมกัน (Inactive / Under Maintenance / Lost / Disposed) */
  inactive: number;
  /** null = ไม่มีชิ้นให้คิดเปอร์เซ็นต์ — 0 แปลว่า "ไม่มี Active สักชิ้น" ซึ่งคนละเรื่อง */
  activePercent: number | null;
  inactivePercent: number | null;
  /** แยกทีละสถานะ เรียงตามลำดับใน enum — สถานะที่ไม่มีชิ้นเลยจะไม่อยู่ในลิสต์ */
  breakdown: StatusCount[];
}

/**
 * หนึ่งแถวต่อหนึ่งแผนก — **รวมแผนกที่ยังไม่มีสินทรัพย์เลย** (assets = 0, ยอดเงินเป็น null)
 *
 * แผนกที่โผล่ในลิสต์นี้คือ: แผนกที่เปิดใช้งานทั้งหมด + แผนกที่ปิดใช้งานแล้วแต่ยังมีของค้าง
 * + แถวของชิ้นที่ยังไม่ระบุแผนก (ถ้ามี) — รวมกันแล้ว `sum(assets)` ต้องเท่ากับ
 * `DashboardTotals.assets` เสมอ ใช้ตรวจได้ว่าตัวเลขบนหน้ายังกระทบยอดกันอยู่
 */
export interface DepartmentSummary {
  /** null = แถวรวมของชิ้นที่ยังไม่ได้ระบุแผนก (asset.departmentId เป็น NULL) ไม่ใช่แผนกจริง */
  departmentId: number | null;
  departmentName: string | null;
  /** 0 ได้ = แผนกนี้ยังไม่มีสินทรัพย์ในทะเบียนสักชิ้น (ไม่ใช่ข้อมูลหาย) */
  assets: number;
  active: number;
  /** null เมื่อไม่มีชิ้นไหนในแผนกนี้ที่มีตัวเลขบัญชีครบ — รวมถึงแผนกที่ยังไม่มีของเลย */
  bookedCost: number | null;
  accumulatedDepreciation: number | null;
  netBookValue: number | null;
}

export interface DashboardOverview {
  scope: DashboardScope;
  totals: DashboardTotals;
  freshness: DashboardFreshness;
  status: DashboardStatus;
  /** สรุปรายแผนกในขอบเขตเดียวกับ totals — กรองแผนกเดียวอยู่ก็จะเหลือแถวเดียว */
  byDepartment: DepartmentSummary[];
}

export interface DashboardOverviewInput {
  departmentId?: number;
}
