// ประตูตรวจ request — request ที่ผิดฟอร์มโดน 422 ตั้งแต่ตรงนี้ service ไม่ต้องกันเอง
// ไม่มี createdBy/updatedBy/deletedBy: identity มาจาก token (currentUser.id) เท่านั้น
// ห้ามรับจาก body — ไม่งั้นคนที่ล็อกอินแล้วอ้างเป็นใครก็ได้ในประวัติสินทรัพย์
import { t } from 'elysia';
import { paginationQuery } from '@common/pagination';

export const assetIdParams = t.Object({ id: t.Numeric() });

export const assetListQuery = t.Object({
  requestId: t.Numeric(),
});

/**
 * หน้า Asset Inventory — ค้น + กรองแผนก + แบ่งหน้า
 *
 * แบ่งหน้าเสมอ ไม่มีทางเลือก "เอาทั้งหมด": ทะเบียนจริงมี 2,700+ ชิ้นและโตขึ้นเรื่อย ๆ
 * (ต่างจาก /master/* ที่คืนครบเพราะมีหลักสิบแถว) paginationQuery มี default page=1 limit=20
 * และเพดาน 100 มาให้แล้ว
 *
 * ไม่มี requireRole ที่เส้นนี้และไม่มีการล็อกแผนกตาม role — ต่างจาก /dashboard/overview
 * โดยตั้งใจ: หน้านี้คือ "ทะเบียนของว่ามีอะไรอยู่ที่ไหน" ซึ่งทุกคนต้องค้นได้ (คนที่ตามหา
 * เครื่องมักไม่ใช่คนแผนกเดียวกับที่ของสังกัดอยู่) ส่วนที่ปิดคือมูลค่ารวมรายแผนกบน dashboard
 */
export const assetInventoryQuery = t.Composite([
  paginationQuery,
  t.Object({
    // ค้นเลขสินทรัพย์ / รายละเอียด / เลขเครื่อง — คนจำได้ไม่เหมือนกัน
    search: t.Optional(t.String({ maxLength: 100 })),
    departmentId: t.Optional(t.Numeric({ minimum: 1 })),
    // รหัสบริษัท (company.code) — ไม่ส่ง = ทุกบริษัท ความยาวตรงกับ varchar(20)
    // ไม่เช็คว่ามีจริงเหมือน /dashboard/overview: ที่นี่เป็นตัวกรองของตารางค้นหา
    // รหัสมั่วได้ผลลัพธ์ว่างซึ่งอ่านถูกอยู่แล้ว ไม่ต้องจ่ายค่า query ตาราง company ทุกครั้ง
    companyCode: t.Optional(t.String({ minLength: 1, maxLength: 20 })),

    // ── ตัวกรองของหน้าทะเบียน ───────────────────────────────────────────────
    locationId: t.Optional(t.Numeric({ minimum: 1 })),

    // ต้องเป็น union ของค่าจริงใน enum asset_status ไม่ใช่ t.String()
    // ส่งค่านอก enum เข้าไปเทียบ Postgres จะโยน 22P02 (invalid input value for enum)
    // ซึ่งกลายเป็น 500 ทั้งที่เป็นแค่ query ที่พิมพ์ผิด — ให้ตกที่ประตูนี้เป็น 422 แทน
    status: t.Optional(
      t.Union([
        t.Literal('Active'),
        t.Literal('Inactive'),
        t.Literal('Under Maintenance'),
        t.Literal('Lost'),
        t.Literal('Disposed'),
      ]),
    ),

    /**
     * ปีบัญชีของตัวเลขที่ sync มา (asset_accounting.fiscalYear) — ไม่ใช่ปีที่ซื้อ
     *
     * ★ ชิ้นที่ยังไม่มีแถวบัญชีจะหลุดออกจากผลเมื่อกรองด้วยตัวนี้ ซึ่งถูกแล้ว:
     *   "ขอชิ้นที่ตัวเลขเป็นของปี 2022" กับ "ชิ้นที่ไม่มีตัวเลขเลย" คนละคำถาม
     */
    fiscalYear: t.Optional(t.Numeric({ minimum: 1900, maximum: 3000 })),

    /**
     * ช่วงมูลค่าคงเหลือ — คิดจาก bookedCost − accumulatedDepreciation ตอนคิวรี
     * (ไม่มีคอลัมน์ NBV เก็บไว้ ดูหัวไฟล์ของตาราง asset_accounting)
     *
     * ★ ชิ้นที่ SAP ให้ตัวเลขมาไม่ครบจะหลุดออกจากผลเช่นกัน เพราะเทียบค่าไม่ได้
     *   ติดลบได้จริง (ของที่ตัดค่าเสื่อมเกินราคาทุน) จึงไม่ตั้ง minimum ไว้
     */
    minNetBookValue: t.Optional(t.Numeric()),
    maxNetBookValue: t.Optional(t.Numeric()),
  }),
]);

export const createAssetBody = t.Object({
  requestId: t.Integer({ minimum: 1 }),
  grpoLineId: t.String({ format: 'uuid' }),

  description: t.Optional(t.String({ maxLength: 100 })),
  serialNumber: t.Optional(t.String({ maxLength: 100 })),
  assetClass: t.Optional(t.String({ maxLength: 50 })),

  // ไม่มี categoryId/uom โดยตั้งใจ (ถอดออกใน 0007) — สองตัวนี้อยู่ที่ OITM ของ SAP
  // ไม่ได้อยู่บน PO คนกรอกฟอร์มจึงไม่มีทางรู้ ต้องรอ job ที่ map จาก itemCode มาเติมทีหลัง
  // เดิมบังคับรับจาก body ทั้งที่ฟอร์มไม่มีช่องให้กรอก ผลคือ POST /assets ได้ 422 ทุกครั้ง
  // (แก้ทีหลังผ่าน PATCH ได้ — updateAssetBody ยังรับสองตัวนี้อยู่)
  locationId: t.Integer({ minimum: 1 }),
  subLocationId: t.Optional(t.Integer({ minimum: 1 })),
  // แผนกที่สังกัด — คนละแกนกับผู้ถือครอง ของกลางที่ไม่มีเจ้าของก็ยังระบุแผนกได้
  departmentId: t.Optional(t.Integer({ minimum: 1 })),
  employeeId: t.Optional(t.Integer({ minimum: 1 })),

  warrantyStartDate: t.Optional(t.String()),
  warrantyEndDate: t.Optional(t.String()),

  // เลขช่องที่ผู้ใช้กรอก (ตรงกับที่เห็นบนฟอร์ม) — ไม่ส่งมาก็ต่อท้ายให้
  // ส่งมาแล้วชนกับที่มีอยู่ = 409 (unique ที่ DB เป็นคนตัดสิน ไม่ใช่การนับ)
  unitNo: t.Optional(t.Integer({ minimum: 1 })),
  // ราคาทุนที่เสนอ — ไม่ส่งมาใช้ unitPrice ของ PO line; งานเหมาที่แตกหลายชิ้นต้องส่งเอง
  acquisitionCost: t.Optional(t.Number({ minimum: 0 })),

  // id จาก POST /uploads — ไม่รับไฟล์ตรงนี้
  imageId: t.Optional(t.String({ format: 'uuid' })),
});

// แก้ได้เฉพาะข้อมูลของชิ้น — requestId ย้ายไม่ได้
// grpoLineId ย้ายได้ภายใน PO line เดียวกัน: งานเหมาที่ทยอยส่ง คนกรอกอาจผูกรอบผิดตอนแรก
// (ตอนนั้นมีรอบเดียว) การบังคับให้ลบแล้วสร้างใหม่คือการทิ้งข้อมูลที่กรอกไปแล้วโดยไม่จำเป็น
export const updateAssetBody = t.Object({
  grpoLineId: t.Optional(t.String({ format: 'uuid' })),
  acquisitionCost: t.Optional(t.Number({ minimum: 0 })),
  description: t.Optional(t.String({ maxLength: 100 })),
  /**
   * รับ null ได้ = "ลบเลขเครื่องที่เคยกรอกไว้" (คอลัมน์เป็น nullable ตั้งแต่แรก)
   *
   * ต่างจาก undefined ซึ่งแปลว่า "ไม่ได้แก้ช่องนี้" แล้ว .set() จะไม่แตะคอลัมน์เลย — ถ้าไม่มี
   * null ให้ใช้ ผู้ใช้ที่ลบเลขในช่องแล้วกดบันทึกจะได้ค่าเดิมกลับมาโดยไม่มีอะไรบอกว่าไม่ได้ลบ
   *
   * ★ ไม่ได้แปลว่าส่งใบได้โดยไม่มีเลขเครื่อง — assertSubmittable ยังบังคับตอนกดส่งอยู่
   * (DRAFT ตั้งใจให้หลวม ความเข้มอยู่ที่ด่านก่อนส่ง — ดูคอมเมนต์ที่ assertSubmittable)
   */
  serialNumber: t.Optional(t.Union([t.String({ maxLength: 100 }), t.Null()])),
  assetClass: t.Optional(t.String({ maxLength: 50 })),
  categoryId: t.Optional(t.Integer({ minimum: 1 })),
  // string ไม่ใช่ id ตั้งแต่ 0011 — ตาราง uom ถูกถอด หน่วยนับ sync มาจาก OITM.InvntryUom
  uom: t.Optional(t.String({ maxLength: 20 })),
  locationId: t.Optional(t.Integer({ minimum: 1 })),
  subLocationId: t.Optional(t.Integer({ minimum: 1 })),
  departmentId: t.Optional(t.Integer({ minimum: 1 })),
  employeeId: t.Optional(t.Integer({ minimum: 1 })),
  warrantyStartDate: t.Optional(t.String()),
  warrantyEndDate: t.Optional(t.String()),
  // รับ null ได้ต่างจากฝั่ง create — "ถอดรูปออกโดยไม่ใส่ใหม่" ต้องสั่งได้
  //
  // t.Optional เฉย ๆ แยกไม่ออกระหว่าง "ไม่ได้แก้ช่องนี้" (ไม่ส่งมา) กับ "ลบรูปทิ้ง"
  // ซึ่งเป็นคนละเจตนา — ผลคือกดลบแล้วบันทึก รูปเดิมยังผูกอยู่เหมือนไม่มีอะไรเกิดขึ้น
  //   ไม่ส่ง key มา = ไม่แตะคอลัมน์
  //   ส่ง null     = ล้างเป็น NULL
  imageId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
});

// เลขสินทรัพย์ที่สแกนมาจาก QR — ไม่บังคับ pattern โดยตั้งใจ
//
// ของจริงในทะเบียนมีเลขที่ไม่เข้าสคีมาอยู่ 7 ชิ้น (ชิ้นส่วนย่อยที่ใช้จุด/ทับ และตัวที่มีคน
// กรอกชื่อสินค้าลงช่อง ItemCode) ถ้าบังคับ ASSET_NUMBER_REGEX ที่นี่ สติกเกอร์ของเจ็ดชิ้นนั้น
// จะสแกนแล้วขึ้น 422 ทั้งที่ของมีอยู่จริงในระบบ — ปล่อยให้ service ตอบ 404 ถ้าหาไม่เจอพอ
export const assetByNumberQuery = t.Object({
  // ★ ต้องระบุบริษัท (0021) — ไม่ใช่เรื่องสิทธิ์ แต่เป็นเรื่องความกำกวม:
  //   เลขสินทรัพย์ซ้ำกันข้ามบริษัทจริง 24 ตัว เลขเปล่าจึงตอบได้สองชิ้น
  //   ค่านี้มาจาก URL ที่ QR ฝังไว้ให้แล้ว (ดู assetQrUrl)
  company: t.String({ minLength: 1, maxLength: 20 }),
  number: t.String({ minLength: 1, maxLength: 100 }),
});
