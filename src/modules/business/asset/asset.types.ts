// สัญญาชนิดข้อมูลของโมดูล asset — ไฟล์นี้ไม่มี logic และไม่ import service
// (service import types ทางเดียว กัน import วน)
//
// ชนิดที่ "มีอยู่แล้วในตาราง" derive จาก schema เสมอ ไม่พิมพ์ซ้ำด้วยมือ —
// คอลัมน์เปลี่ยนชนิดเมื่อไหร่ ที่นี่เปลี่ยนตาม แล้ว compiler จะชี้จุดที่ต้องแก้ให้เอง
import type { asset, assetRequest } from '@intrastucture/db/schema';

export type AssetRow = typeof asset.$inferSelect;
export type AssetLifecycle = AssetRow['lifecycle'];
export type RequestStatus = (typeof assetRequest.$inferSelect)['status'];

// ── ช่องกรอกในหน้าฟอร์ม ────────────────────────────────────────────────────
// union แบบ discriminate ด้วย status: ฟิลด์ของแต่ละสถานะไม่เหมือนกัน
// ถ้าประกาศเป็น interface เดียวที่ทุกฟิลด์ optional ฝั่งใช้งานจะต้องเช็ค undefined
// ทุกจุดโดยไม่จำเป็น — แบบนี้ narrow ด้วย slot.status ครั้งเดียวแล้วได้ฟิลด์ครบ
export type SlotStatus = 'registered' | 'pending' | 'noGrpo';

/**
 * ป้ายสถานะที่ผู้ใช้เห็นจริงบนหน้าจอ — "หนึ่งช่อง หนึ่งคำตอบ"
 *
 * ★ คำนวณที่ backend ที่เดียวเท่านั้น ห้าม frontend derive เอง
 *
 * ค่าพวกนี้รวมสามแกนที่ระบบเก็บแยกกันไว้เข้าด้วยกัน:
 *   ช่อง (มี GRPO ไหม / มีแถว asset ไหม)  →  noGrpo, pendingCreation
 *   ใบ   (asset_request.status)            →  saved, pendingManager, approved
 *   ชิ้น (asset.lifecycle + rejectedAt)     →  registered, cancelled, rejected
 *
 * การรวมสามแกนต้องทำที่เดียวเพราะมันถูกใช้ 4 ที่ (ตารางลงทะเบียน, คิวบัญชี, การ์ด Teams,
 * รายงาน) — ปล่อยให้แต่ละที่คิดเอง = เพี้ยนคนละแบบ ซึ่งเคยเกิดมาแล้ว: ป้ายเดิมอ่านสถานะจาก
 * "ใบที่กำลังเปิดดู" แทน "ใบที่เป็นเจ้าของชิ้น" ทำให้ชิ้นที่อนุมัติไปแล้วขึ้น Saved เมื่อเปิด
 * ผ่านใบรอบใหม่ของ PO เดียวกัน (findSlotsByRequest นับข้ามใบ)
 */
export type SlotDisplayStatus =
  /** ของยังมาไม่ถึง (ยังไม่มี GRPO รองรับช่องนี้) */
  | 'noGrpo'
  /** ของมาถึงแล้ว ยังไม่มีใครกรอก — ช่องนี้กดกรอกได้ */
  | 'pendingCreation'
  /** กรอกแล้ว แต่ใบยังไม่ถูกส่งไปขออนุมัติ */
  | 'saved'
  /** ส่งไปหาหัวหน้าแล้ว รออนุมัติ */
  | 'pendingManager'
  /** ถูกตีกลับ — ทั้งใบโดยหัวหน้า หรือรายชิ้นโดยบัญชี (ดู rejectedRole ว่ามาจากไหน) */
  | 'rejected'
  /** อนุมัติแล้ว รอบัญชีออกเลขสินทรัพย์ */
  | 'approved'
  /** บัญชีออกเลขแล้ว = อยู่ในทะเบียน SAP */
  | 'registered'
  /** บัญชีปิดถาวร — ช่องนี้ไม่รับสินทรัพย์อีกแล้ว */
  | 'cancelled';

/** ลงทะเบียนแล้ว — มีแถวใน asset จริง */
export interface RegisteredSlot {
  /** ลำดับบนจอของ PO line นี้ (1..n) — คนละตัวกับ unitNo */
  index: number;
  status: 'registered';
  /** ★ ป้ายที่หน้าจอต้องแสดง — ใช้ค่านี้ตรง ๆ อย่าคำนวณใหม่จาก status/lifecycle */
  displayStatus: SlotDisplayStatus;
  assetId: number;
  /** เลขชิ้นจริงในตาราง (unique ต่อ PO line ข้ามใบคำขอ) */
  unitNo: number;
  /**
   * ใบคำขอที่เป็นเจ้าของชิ้นนี้
   *
   * ไม่เท่ากับ requestId ที่ถามมาได้ — PO เดียวเปิดคำขอได้หลายรอบ และช่องเป็นของ
   * PO line ไม่ใช่ของใบ ผู้เรียกต้องเทียบเองว่าชิ้นไหนเป็นของใบที่กำลังดูอยู่
   * (แก้ไข/ส่งอนุมัติได้เฉพาะของใบตัวเอง)
   */
  requestId: number;
  serialNumber: string | null;
  acquisitionCost: number;
  lifecycle: AssetLifecycle;
  /** id ของไฟล์รูป (null = ยังไม่แนบ) — ไม่ใช่ URL เพราะไฟล์อยู่หลัง authGuard */
  imageId: string | null;
  /** ชื่อสถานที่ที่ของชิ้นนี้จะไปอยู่ — ส่งชื่อไม่ส่ง id เพราะปลายทางคือคนอ่าน */
  locationName: string | null;
  /** ตำแหน่งย่อยในสถานที่นั้น (null = ไม่ได้ระบุ — asset.subLocationId เป็น nullable) */
  subLocationName: string | null;
  /** ผู้ถือครอง — ประกอบด้วย employeeName() ตัวเดียวกับ dropdown ในฟอร์ม (ไทยก่อน) */
  employeeName: string | null;
  /** แผนกที่สังกัด — คนละแกนกับผู้ถือครอง ของกลางไม่มีคนถือแต่มีแผนกได้ */
  departmentName: string | null;
  /** ระยะประกัน — ส่งดิบทั้งคู่ ให้ฝั่งแสดงผลประกอบข้อความเอง (รูปแบบวันที่เป็นเรื่องของ locale) */
  warrantyStartDate: string | null;
  warrantyEndDate: string | null;
  grpoLineId: string;
  grpoNo: string;

  // ── ร่องรอยการตัดสินใจของคน — ส่งเป็น "ชื่อ" ไม่ใช่ id เพราะปลายทางคือคนอ่านบนหน้าจอ
  //    ทั้งหมดเป็นของชิ้นนี้เท่านั้น (อ่านจากใบเจ้าของชิ้น ไม่ใช่ใบที่กำลังเปิดดู)

  /** เลขสินทรัพย์จาก SAP — มีเมื่อ displayStatus = 'registered' */
  assetNumber: string | null;
  /**
   * URL ที่ฝังอยู่ใน QR ของสติกเกอร์ชิ้นนี้ (null = ยังไม่มีเลข จึงยังไม่มี QR)
   *
   * ส่งค่าที่เก็บไว้จริง ไม่ใช่ประกอบใหม่จาก assetNumber ตอนแสดงผล — สติกเกอร์ที่พิมพ์ไป
   * แล้วถือค่าที่เก็บไว้ตอนออกเลข ถ้าหน้าจอประกอบเองจะเห็นค่าที่ "ควรเป็น" ไม่ใช่ค่าที่
   * พิมพ์ติดอยู่บนของจริง แล้วจะไม่มีใครรู้เลยว่าสองอันไม่ตรงกัน
   */
  qrCode: string | null;
  /** ใครอนุมัติใบที่ชิ้นนี้สังกัด (null = ยังไม่ถูกอนุมัติ) */
  approvedByName: string | null;
  /**
   * ใครออกเลขให้ชิ้นนี้ (null = ยังไม่มีเลข หรือเป็นชิ้นเก่าก่อน 0019 ที่ไม่ได้บันทึกไว้)
   *
   * คู่กับ approvedByName ตอบคำถามว่า "ใครอนุมัติ ใครปิดงาน" — เป็นของรายชิ้น ไม่ใช่
   * asset_request.completedBy ซึ่งคือคนกดปิดทั้งใบและยังว่างตลอดช่วงที่ทยอยออกเลขทีละชิ้น
   */
  registeredByName: string | null;
  /**
   * เหตุผลที่ถูกตีกลับ — backend เลือกให้แล้วว่ามาจากระดับชิ้น (บัญชี) หรือระดับใบ (หัวหน้า)
   * ระดับชิ้นชนะเสมอเมื่อมีทั้งคู่: มันใหม่กว่าและเจาะจงกว่า
   */
  rejectReason: string | null;
  rejectedByName: string | null;
  /** role ณ ตอนกดตีกลับ (MANAGER/FINANCE/ADMIN) — ตอบว่า "ตีกลับมาจากไหน" */
  rejectedRole: string | null;
  /**
   * เคยถูกตีกลับและผู้ขอแก้กลับมาแล้ว แต่ยังไม่ได้ออกเลข (asset.rejectFixedAt)
   *
   * ไม่ใช่ displayStatus ใหม่ — สถานะของชิ้นยังเหมือนชิ้นที่รอออกเลขทั่วไปทุกอย่าง
   * ต่างกันแค่ "บัญชีควรตรวจซ้ำว่าแก้ตามที่สั่งไปหรือยัง" จึงเป็นป้ายเสริม ไม่ใช่สถานะ
   */
  rejectFixed: boolean;
  /** เหตุผล/ผู้กดปิดถาวร — มีเมื่อ displayStatus = 'cancelled' */
  cancelReason: string | null;
  cancelledByName: string | null;
}

export interface PendingSlot {
  index: number;
  status: 'pending';
  displayStatus: 'pendingCreation';
  /** เลขชิ้นที่จองไว้ให้ช่องนี้ — client ต้องส่งค่านี้กลับมาใน POST /assets */
  unitNo: number;
  grpoLineId: string;
  grpoNo: string;
}

export interface NoGrpoSlot {
  index: number;
  status: 'noGrpo';
  displayStatus: 'noGrpo';
}

export type AssetSlot = RegisteredSlot | PendingSlot | NoGrpoSlot;

/** คิวของช่องที่รอผูกกับรอบรับของ — โครงภายในของ findSlotsByRequest */
export interface PendingSlotRef {
  grpoLineId: string;
  grpoNo: string;
}

export interface SlotInvoice {
  id: string;
  originalName: string;
  mimeType: string;
  size: number;
}

export interface SlotGrpoLine {
  id: string;
  /** integer — ใช้เรียก PATCH/DELETE /grpo/:id/invoice */
  grpoId: number;
  grpoNo: string;
  grpoDate: string;
  receivedQty: number;
  /** null = รอบนี้ไม่มีใครแจ้งจำนวนเอง ใช้ receivedQty ตาม SAP */
  declaredQty: number | null;
  declaredReason: string | null;
  registered: number;
  invoices: SlotInvoice[];
}

export interface SlotItem {
  poItemId: string;
  poLine: number;
  itemDescription: string;
  unitPrice: number;
  lineTotal: number;
  ordered: number;
  received: number;
  registered: number;
  planned: number;
  lineAmount: number;
  registeredCost: number;
  isDeclared: boolean;
  overQty: boolean;
  overCost: boolean;
  grpoLines: SlotGrpoLine[];
  slots: AssetSlot[];
}

export interface AssetSlotsResponse {
  requestId: number;
  poNumber: string;
  status: RequestStatus;
  /**
   * เหตุผลที่หัวหน้าตีกลับ — มีค่าเฉพาะตอน status = 'REJECTED'
   *
   * ส่งมาพร้อมช่องในรอบเดียวกันเพราะหน้าตารางต้องใช้ทั้งคู่ตัดสินใจแสดงผล: สถานะบอกว่า
   * ป้ายรายชิ้นเป็น Rejected และเหตุผลคือสิ่งเดียวที่บอกผู้ใช้ว่าต้องแก้อะไรก่อนส่งใหม่
   * ให้ไปดึงจาก GET /asset-requests/:id แยกอีกเส้นแปลว่าตารางเรนเดอร์ป้าย Rejected
   * เสร็จไปแล้วก่อนเหตุผลจะมาถึง — ผู้ใช้เห็นว่าโดนตีกลับแต่ยังไม่รู้ว่าทำไม
   *
   * ยังเป็น null ได้แม้ตอน REJECTED: ใบที่ถูกตีกลับผ่านการ์ด Teams ส่ง comments ว่างมาได้
   */
  rejectReason: string | null;
  items: SlotItem[];
}

/** ผลของ soft delete — คงรูป { success, id } ที่ frontend อ่านอยู่ */
export interface DeleteAssetResult {
  success: true;
  id: number;
}

/** ข้อมูลอ้างอิงที่ต้องตรวจก่อนเขียน — ใช้ร่วมกันทั้ง create และ update */
export interface MasterRefInput {
  categoryId?: number;
  // ไม่มี uomId — asset.uom เป็น varchar ตั้งแต่ 0011 ไม่มี FK ให้ตรวจ
  locationId?: number;
  subLocationId?: number | null;
  departmentId?: number | null;
  employeeId?: number | null;
}

// ── หน้า My asset ───────────────────────────────────────────────────────────

/**
 * ชุดตัวเลขบัญชีของชิ้นหนึ่ง — snapshot จาก SAP (ดู asset_accounting)
 *
 * ⚠️ ทุกช่องเป็นตัวเลขของ **ปี fiscalYear** ไม่ใช่ปีปัจจุบันเสมอไป — ของที่ตัดจำหน่าย/
 * หยุดคิดค่าเสื่อมแล้วจะค้างที่ปีสุดท้ายของมัน (วัด 2026-08-20: 668 จาก 2,721 ชิ้น = 25%
 * ไม่ใช่ปี 2026) หน้าจอต้องแสดงปีคู่กับตัวเลขเสมอ ห้ามโชว์ยอดลอย ๆ
 */
export interface MyAssetAccounting {
  fiscalYear: number;
  bookedCost: number | null;
  accumulatedDepreciation: number | null;
  /**
   * คำนวณตอนตอบ ไม่ได้เก็บในตาราง — SAP เองก็ไม่เก็บ มันคำนวณตอนเปิดรายงาน
   * null เมื่อขาดตัวตั้งหรือตัวลบ (เช่นชิ้นที่มีรายการปรับปรุงที่ระบบยังไม่รองรับ)
   */
  netBookValue: number | null;
  salvageValue: number | null;
  /** หน่วยเป็น **เดือน** ตามที่ SAP เก็บ (60 = 5 ปี) — 0 ได้จริงเช่นที่ดินที่ไม่คิดค่าเสื่อม */
  usefulLifeMonths: number | null;
  remainingLifeMonths: number | null;
  depreciationMethod: string | null;
  depreciationStart: string | null;
  depreciationEnd: string | null;
  /** ดึงมาล่าสุดเมื่อไหร่ — คนละเรื่องกับ fiscalYear ที่บอกว่าตัวเลขเป็นของปีไหน */
  syncedAt: string;
}

/** หนึ่งชิ้นในหน้า My asset */
export interface MyAssetItem {
  id: number;
  /**
   * บริษัทเจ้าของชิ้น — จำเป็นสำหรับเปิดรายละเอียดผ่าน GET /assets/by-number
   *
   * ★ เลขสินทรัพย์ซ้ำกันข้ามบริษัทจริง 24 ตัว (วัดจาก OITM) เลขเปล่าจึงชี้ได้สองชิ้น
   *   ต้องส่งคู่กันเสมอ ห้ามให้หน้าจอเดาว่าเป็นบริษัทไหน
   */
  companyCode: string;
  assetNumber: string | null;
  description: string | null;
  imageId: string | null;
  /**
   * URL ที่ฝังใน QR บนสติกเกอร์ — เก็บไว้ตอน sync/ออกเลข ไม่ได้ประกอบใหม่ตอนอ่าน
   *
   * หน้าจอต้องวาดจากค่านี้เท่านั้น ห้ามประกอบ URL เองจาก assetNumber: ค่าที่เก็บไว้คือค่า
   * ที่ตรงกับสติกเกอร์ที่พิมพ์แปะไปแล้ว ถ้าจอประกอบเอง วันที่ APP_BASE_URL เปลี่ยนจอจะโชว์
   * QR ใหม่ที่ไม่ตรงกับของจริงบนเครื่อง โดยไม่มีอะไรฟ้อง
   */
  qrCode: string | null;
  categoryName: string | null;
  locationName: string;
  subLocationName: string | null;
  acquisitionDate: string | null;
  /** ราคาที่เสนอตอนขอซื้อ/ยอดใบกำกับ — **คนละค่ากับ** accounting.bookedCost (APC) */
  acquisitionCost: number | null;
  /** null = SAP ยังไม่มียอดบัญชีให้ชิ้นนี้ (หรือยังไม่เคย sync) */
  accounting: MyAssetAccounting | null;
}

export interface MyAssetsResponse {
  /**
   * false = บัญชีผู้ใช้นี้ยังไม่ได้ผูกกับพนักงาน จึงไม่มีทางรู้ว่าถือของชิ้นไหน
   *
   * ต้องแยกจาก "items ว่าง" ให้ขาด: อันแรกคือ admin ต้องไปผูก user กับ employee ให้ก่อน
   * อันหลังคือไม่มีของในความดูแลจริง ๆ ถ้ากลืนเป็นเคสเดียวกัน คนที่ตั้งค่าไม่ครบจะเห็น
   * "ไม่มีสินทรัพย์" ไปตลอดกาลโดยไม่มีใครรู้ว่าต้องแก้อะไร
   */
  linkedToEmployee: boolean;
  items: MyAssetItem[];
}

/**
 * รายละเอียดชิ้นหนึ่งที่เปิดจากการสแกน QR — หน้า /assets/:assetNumber
 *
 * ต่างจาก MyAssetItem ตรงที่ต้องตอบ "ของชิ้นนี้คืออะไร อยู่ไหน ใครดูแล" ให้คนที่ยืนอยู่หน้า
 * เครื่องจริง ไม่ใช่แค่ตัวเลขบัญชี — คนสแกนส่วนใหญ่ไม่ใช่เจ้าของชิ้นนั้น
 */
export interface AssetByNumberDetail {
  id: number;
  assetNumber: string;
  description: string | null;
  imageId: string | null;
  serialNumber: string | null;
  uom: string | null;
  /** สตริงดิบจาก SAP — เก็บไว้ให้บัญชีตรวจย้อนได้ว่าหมวด/แผนกมาจากอะไร */
  assetClass: string | null;
  status: string;
  lifecycle: string;
  categoryName: string | null;
  locationName: string;
  subLocationName: string | null;
  departmentName: string | null;
  /** ผู้ถือครองตามทะเบียน — null = ยังไม่ได้ระบุ (ของเก่าส่วนใหญ่เป็นแบบนี้) */
  holderName: string | null;
  acquisitionDate: string | null;
  acquisitionCost: number | null;
  /**
   * ระยะประกัน — ส่งดิบทั้งคู่ ให้ฝั่งแสดงผลประกอบข้อความเอง (รูปแบบวันที่เป็นเรื่องของ locale)
   *
   * ★ สอง nullable อิสระจากกัน มีครบ 4 กรณีจริง (ไม่มีเลย / มีแต่เริ่ม / มีแต่จบ / มีทั้งคู่)
   *   ฝั่งแสดงผลต้องเขียนครบทุกกรณี ไม่ใช่สมมติว่ามาคู่กันเสมอ
   *
   * ★ เส้นนี้เปิดสาธารณะ (ปลายทาง QR) — วันหมดประกันไม่ใช่ข้อมูลลับ และเป็นสิ่งที่ช่างที่
   *   ยืนอยู่หน้าเครื่องต้องรู้ก่อนตัดสินใจว่าจะซ่อมเองหรือส่งเคลม จึงปล่อยได้
   */
  warrantyStartDate: string | null;
  warrantyEndDate: string | null;
  accounting: MyAssetAccounting | null;
}

// ── หน้า Asset Inventory (GET /assets/inventory) ────────────────────────────

/**
 * ยอดบัญชีแบบย่อสำหรับ "แถวในตาราง" — ไม่ใช่ MyAssetAccounting ทั้งก้อน
 *
 * ตารางแสดงแค่มูลค่าคงเหลือกับปีของตัวเลข ส่วนที่เหลือ (มูลค่าซาก/อายุ/วิธีคิดค่าเสื่อม)
 * อยู่ในหน้ารายละเอียดของชิ้นนั้นอยู่แล้ว การลากมาทั้งก้อนทีละ 20 แถวคือส่งของที่ไม่มีใครดู
 *
 * ★ fiscalYear ต้องมาคู่กับ netBookValue เสมอ ห้ามตัดทิ้งเพราะ "ตารางแคบ" — ยอดที่ค้าง
 *   ปีเก่ามีจริงในทะเบียน ถ้าไม่ติดป้ายปี คนจะอ่านเลขปี 2022 เป็นมูลค่าวันนี้
 */
export interface InventoryAccounting {
  fiscalYear: number;
  netBookValue: number | null;
}

/** หนึ่งแถวในตาราง Asset Inventory */
export interface InventoryItem {
  id: number;
  /**
   * ใช้ประกอบลิงก์ไปหน้ารายละเอียด /assets/:company/:assetNumber
   * จำเป็นเพราะเลขสินทรัพย์ซ้ำกันข้ามบริษัทจริง 24 ตัว — เลขเปล่าชี้ได้สองชิ้น
   */
  companyCode: string;
  /** ไม่เป็น null — หน้านี้แสดงเฉพาะชิ้นที่ลงทะเบียนแล้ว ซึ่ง DB บังคับว่าต้องมีเลข */
  assetNumber: string;
  description: string | null;
  serialNumber: string | null;
  imageId: string | null;
  categoryName: string | null;
  departmentName: string | null;
  locationName: string;
  subLocationName: string | null;
  holderName: string | null;
  status: AssetRow['status'];
  acquisitionDate: string | null;
  /** null = SAP ยังไม่มียอดบัญชีให้ชิ้นนี้ */
  accounting: InventoryAccounting | null;
}

export interface InventoryListInput {
  page: number;
  limit: number;
  search?: string;
  departmentId?: number;
  /** รหัสบริษัท — ตารางบน Dashboard ส่งมาให้ตรงกับการ์ดสรุปข้างบน */
  companyCode?: string;
  locationId?: number;
  status?: AssetRow['status'];
  /** ปีบัญชีของตัวเลขที่ sync มา ไม่ใช่ปีที่ซื้อ — ชิ้นที่ไม่มีแถวบัญชีจะไม่อยู่ในผล */
  fiscalYear?: number;
  /** ช่วงมูลค่าคงเหลือ — ชิ้นที่คำนวณ NBV ไม่ได้จะไม่อยู่ในผล (เทียบค่าไม่ได้) */
  minNetBookValue?: number;
  maxNetBookValue?: number;
}
