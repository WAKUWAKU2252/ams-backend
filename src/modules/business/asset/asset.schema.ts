// ประตูตรวจ request — request ที่ผิดฟอร์มโดน 422 ตั้งแต่ตรงนี้ service ไม่ต้องกันเอง
// ไม่มี createdBy/updatedBy/deletedBy: identity มาจาก token (currentUser.id) เท่านั้น
// ห้ามรับจาก body — ไม่งั้นคนที่ล็อกอินแล้วอ้างเป็นใครก็ได้ในประวัติสินทรัพย์
import { t } from 'elysia';
import { paginationQuery } from '@common/pagination';

export const assetIdParams = t.Object({ id: t.Numeric() });

/** ของในห้องหนึ่ง — หน้าแผนผังเรียก (0024) */
export const roomAssetsParams = t.Object({ subLocationId: t.Numeric({ minimum: 1 }) });

/**
 * แบ่งหน้าของในห้อง — หน้าแผนผังโหลดต่อทีละหน้าเมื่อเลื่อนลิสต์ลงไปสุด
 *
 * ★ ไม่ใช้ paginationQuery ร่วมกับหน้าทะเบียน เพราะขนาดหน้าที่นี่ไม่ใช่เรื่องของผู้เรียก:
 *   ทุกชิ้นที่ส่งกลับไปจะถูกวาดเป็นหมุดบนผังด้วย (หน้าจอเอา items ชุดเดียวไปใช้สองที่)
 *   ปล่อยให้ตั้ง limit เองเมื่อไหร่ ห้องคลังจะถูกขอทีเดียว 100 ชิ้นแล้วผังกลายเป็นดงหมุด
 *   ทับกันจนคลิกไม่ถูก — ขนาดหน้าจึงตรึงไว้ที่ ROOM_PAGE_SIZE ฝั่ง service
 */
export const roomAssetsQuery = t.Object({
  page: t.Number({ minimum: 1, default: 1 }),
});

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

    /**
     * ผู้ถือครอง (asset.employeeId) — ตารางบน Dashboard ใช้กรอง "ของอยู่ในมือใคร"
     *
     * ★ เป็น id ของ employee ไม่ใช่ user — ผู้ถือครองคือตัวตนฝั่ง HR ซึ่งมีคนที่ไม่มี
     *   บัญชีเข้าระบบรวมอยู่ด้วย (ดูคอมเมนต์ที่ asset.employeeId)
     * ★ กรอง "ยังไม่ระบุผู้ถือครอง" ด้วยตัวนี้ไม่ได้ minimum: 1 กัน 0 ไว้แล้ว — ถ้าวันหลัง
     *   ต้องการให้เพิ่มพารามิเตอร์แยก อย่ายืมค่า 0 มาแปลว่า NULL เพราะ "ไม่ได้กรอง"
     *   กับ "ขอเฉพาะที่ไม่มีเจ้าของ" เป็นคนละคำถามที่ต้องแยกออกจากกันให้ได้
     */
    employeeId: t.Optional(t.Numeric({ minimum: 1 })),

    // ต้องเป็น union ของค่าจริงใน enum asset_status ไม่ใช่ t.String()
    // ส่งค่านอก enum เข้าไปเทียบ Postgres จะโยน 22P02 (invalid input value for enum)
    // ซึ่งกลายเป็น 500 ทั้งที่เป็นแค่ query ที่พิมพ์ผิด — ให้ตกที่ประตูนี้เป็น 422 แทน
    // ★ สองค่าเท่านั้น — SAP เป็นเจ้าของแกนนี้ 100% (OITM.validFor พูดได้แค่นี้)
    //   enum ใน DB ยังมีอีกสามค่าค้างอยู่ ('Under Maintenance'/'Lost'/'Disposed')
    //   ซึ่งถอดออกจากทางเดินทุกเส้นแล้ว — ห้ามเติมกลับที่นี่ ดู asset.connector/sapStatusRule
    status: t.Optional(t.Union([t.Literal('Active'), t.Literal('Inactive')])),

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

    /**
     * เอาเฉพาะชิ้นที่ระบุห้องไว้แล้ว (asset.subLocationId ไม่ว่าง) — หน้า Audit ใช้
     *
     * ★ default เป็น false ที่ประตูนี้โดยตั้งใจ ไม่ใช่ true: หน้าทะเบียนกับ Dashboard
     *   ที่เรียก endpoint เดียวกันต้องเห็นของครบทุกชิ้นเหมือนเดิม คนที่อยากกรองคือ
     *   หน้า Audit ซึ่งส่ง located=true มาเอง
     *
     * ★ ไม่ได้กรองว่า "ปักหมุดแล้ว" — รู้แค่ว่าอยู่ห้องไหนก็พาคนไปหาของเจอแล้ว
     *   (ตอนนี้ทั้งทะเบียนระบุห้องไว้ 17 ชิ้น ในนั้นปักหมุดแล้ว 13)
     */
    located: t.Optional(t.Boolean({ default: false })),

    /**
     * เรียงตามอะไร — ไม่ส่งมา = เลขสินทรัพย์ (ลำดับที่คนไล่ทะเบียนคุ้นที่สุด)
     *
     * ★ ทิศทางคุมด้วย sortDir แยกอีกตัว — ไม่ยัดรวมเป็น 'netBookValue:asc' เพราะจะกลาย
     *   เป็นสตริงที่ต้องแกะเองทั้งสองฝั่ง และเพิ่มแกนใหม่ทีต้องเพิ่มค่าสองตัวทุกครั้ง
     *
     * ★ NULLS LAST ไม่ใช่ของแถม: ชิ้นที่ SAP ยังไม่มียอดบัญชีให้ (หรือยังไม่มีแถวใน OITM)
     *   จะเป็น NULL ซึ่ง pg เรียง DESC แล้วดัน NULL ขึ้นหัวเป็นค่าเริ่มต้น = หน้าแรกกลาย
     *   เป็นกองของที่ไม่มีข้อมูลทั้งหน้า ซึ่งตรงข้ามกับที่คนกดเรียงต้องการเห็น
     *
     * ★ ใช้คู่กับ random ไม่ได้ — random ชนะเสมอ (ดูที่ service) สองอย่างนี้เป็นคำสั่งเรียง
     *   ที่ขัดกันในตัวเอง หน้า Audit เป็นคนเดียวที่ใช้ random และไม่มีปุ่มเรียงลำดับ
     */
    sort: t.Optional(
      t.Union([
        t.Literal('assetNumber'),
        t.Literal('registered'),
        t.Literal('netBookValue'),
        t.Literal('fiscalYear'),
        // อายุคงเหลือ (ITM7.RemainLife) หน่วยเป็น "เดือน" ตามที่ SAP เก็บ ไม่แปลงหน่วย
        // — ของที่หมดอายุแล้วเป็น 0 ส่วน NULL = ยังไม่มีพารามิเตอร์ค่าเสื่อมใน SAP
        //   สองอย่างนี้ต่างกัน NULLS LAST จึงยังจำเป็นเหมือนแกนอื่น
        t.Literal('remainingLife'),
      ]),
    ),

    /**
     * ทิศทางของ sort — ไม่ส่ง = desc (มาก/ใหม่ก่อน) ซึ่งเป็นสิ่งที่คนกดเรียงอยากเห็นก่อน
     *
     * ★ ไม่มีผลเมื่อไม่ได้ส่ง sort มา — ค่าตั้งต้น (เลขสินทรัพย์ A→Z) ไม่ใช่สิ่งที่หน้าจอ
     *   เปิดให้สลับ ถ้าอยากได้ทางกลับให้ส่ง sort=assetNumber&sortDir=desc มาตรง ๆ
     * ★ NULL อยู่ท้ายสุดทั้งสองทิศ — pg เรียง DESC แล้วดัน NULL ขึ้นหัวเป็นค่าเริ่มต้น
     *   ต้องสั่ง NULLS LAST เองทั้งคู่ ไม่งั้นสลับทิศแล้วหน้าแรกกลายเป็นกองของที่ไม่มีข้อมูล
     */
    sortDir: t.Optional(t.Union([t.Literal('asc'), t.Literal('desc')])),

    /**
     * สุ่มลำดับแทนการเรียงตามเลขสินทรัพย์ — หน้า Audit ใช้ตอนกด "สุ่มรายการตรวจ"
     *
     * ★ สุ่มจาก "ผลที่กรองแล้ว" ไม่ใช่จากทั้งทะเบียน — ตัวกรองทุกตัวข้างบนยังทำงาน
     *   ตามปกติ ตัวนี้เปลี่ยนแค่ ORDER BY (ผู้ตรวจตั้งขอบเขตก่อนแล้วค่อยสุ่มในขอบเขตนั้น)
     *
     * ★ ใช้คู่กับ page > 1 ไม่ได้ในทางความหมาย: ทุกคำขอสุ่มใหม่หมด หน้า 2 จึงไม่ใช่
     *   "ส่วนที่เหลือของหน้า 1" แต่เป็นชุดใหม่ที่ซ้ำกับหน้า 1 ได้ — service บังคับ
     *   offset = 0 ทิ้งเสมอเมื่อ random=true และฝั่งจอซ่อนแถบเลขหน้า
     *   จำนวนที่สุ่มออกมาคุมด้วย limit (เพดาน 100 เท่าเดิม)
     */
    random: t.Optional(t.Boolean({ default: false })),
  }),
]);

/**
 * ── ที่ตั้งบนผัง: "ครบสามช่อง" หรือ "ไม่มีเลยสักช่อง" เท่านั้น ไม่มีทางสายกลาง
 *
 * เดิมเป็นสามช่อง required ตายตัวใน createAssetBody ซึ่งกันของที่ไม่มีห้อง/หมุดได้เด็ดขาด
 * ตามเจตนา ("ของที่ไม่มีห้องและไม่มีหมุดคือของที่คนเดินตรวจนับหาไม่เจอ") แต่พอมีสถานที่
 * ที่ outPlan = true (ต่างประเทศ/สาขาอื่น) กติกานั้นทำให้บันทึกของพวกนั้นไม่ได้เลย
 *
 * ทางที่ผิดคือเปลี่ยนเป็น t.Optional() เฉย ๆ — กำแพงจะหายไปทั้งบาน แล้วเหลือแต่ฝั่งฟอร์ม
 * ที่กันอยู่ ยิง API ตรงก็สร้างของในผังโดยไม่มีห้องได้ทันที
 *
 * union สองรูปเก็บกำแพงไว้ครบโดยไม่ปิดทางของนอกผัง:
 *   รูปที่ 1 (placed)   ต้องมีครบสามช่อง — ของที่อยู่ในผัง
 *   รูปที่ 2 (unplaced) ต้องไม่มีเลยสักช่อง — ของที่อยู่นอกผัง
 *
 * ★ รูปที่ 2 ต้องประกาศทั้งสามช่องเป็น t.Optional(t.Undefined()) ไม่ใช่ t.Object({}) เปล่า ๆ
 *   TypeBox ปล่อย property ส่วนเกินผ่านโดยปริยาย object ว่างจึง match ทุกอย่าง แล้ว union
 *   จะผ่านทางรูปที่ 2 เสมอ = ไม่ได้ตรวจอะไรเลย
 *
 * ★ ส่วนที่ union ตรวจไม่ได้คือ "รูปที่ส่งมาตรงกับ outPlan ของสถานที่นั้นจริงไหม" — ต้องยิง
 *   DB ไปถาม จึงอยู่ที่ assertPlacementUsable ในชั้น service สองด่านนี้ต้องมีคู่กันเสมอ
 *
 * วัดพฤติกรรมจริงแล้ว: ครบสามช่อง ✓ / ไม่มีเลย ✓ / มีห้องไม่มีหมุด ✗ / มีหมุดไม่มีห้อง ✗ /
 * หมุดข้างเดียว ✗ / ส่ง null มา ✗ / พิกัดเกิน 1 ✗
 */
const placementOnPlan = t.Object({
  subLocationId: t.Integer({ minimum: 1 }),
  // สัดส่วนของภาพผัง 0–1 ไม่ใช่ pixel — ต้องมาคู่กันและต้องมี subLocationId ด้วยเสมอ
  // (CHECK ที่ DB บังคับอีกชั้น: ck_asset_pos_pair / ck_asset_pos_range / ck_asset_pos_needs_sub_location)
  posX: t.Number({ minimum: 0, maximum: 1 }),
  posY: t.Number({ minimum: 0, maximum: 1 }),
});

const placementOutOfPlan = t.Object({
  subLocationId: t.Optional(t.Undefined()),
  posX: t.Optional(t.Undefined()),
  posY: t.Optional(t.Undefined()),
});

const createAssetBase = t.Object({
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

  // ── สถานที่ + ห้อง + หมุด บังคับครบสามช่องตอน "สร้าง" ────────────────────────
  //
  // ของที่ไม่มีห้องและไม่มีหมุดคือของที่คนเดินตรวจนับหาไม่เจอ — เดิมสองช่องนี้เป็น optional
  // แล้วของที่กรอกข้ามไปไม่เคยมีใครย้อนกลับมาเติม จึงย้ายมากันตั้งแต่ประตูเข้า
  //
  // ★ บังคับเฉพาะ "ของใหม่" — updateAssetBody ยังปล่อยทั้งสามช่องเป็น optional เหมือนเดิม
  //   โดยตั้งใจ ของเก่าที่บันทึกไว้ก่อนกติกานี้ (และของที่ sync มาจาก SAP) ต้องแก้ช่องอื่น
  //   ได้โดยไม่ถูกล็อกให้ไปเติมสามช่องนี้ก่อน — กติกาใหม่มีไว้กันของใหม่ ไม่ใช่ย้อนบังคับของเดิม
  //
  // ★ ที่ DB ยัง nullable เหมือนเดิม อย่าตามไปใส่ NOT NULL — ck_asset_pos_* คุมแค่ว่า
  //   "ถ้ามีต้องครบคู่และต้องมีห้อง" ซึ่งยังจริงอยู่ ส่วนแถวเก่าทั้งชุดจะกลายเป็นแถวผิดทันที
  //   ถ้าเอากติกาของฟอร์มลงไปเป็นข้อบังคับของตาราง
  //
  // ★ สามช่องนั้น (subLocationId/posX/posY) ย้ายไปอยู่ใน union ท้ายไฟล์นี้แล้ว —
  //   ดู placementOnPlan / placementOutOfPlan ข้างบน
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
  // บังคับตอนสร้างด้วยเหตุผลเดียวกับหมุด (ดูบล็อกข้างบน): รูปคือสิ่งเดียวที่คนหน้างานใช้
  // ยืนยันว่าของตรงหน้าคือชิ้นเดียวกับในทะเบียน ไม่มีรูปแล้วก็ไม่มีใครย้อนกลับมาถ่ายให้
  imageId: t.String({ format: 'uuid' }),
});

/**
 * ★ ต้องเป็น Union ของ Composite ห้ามเป็น Intersect([base, Union([...])])
 *
 * ทรงหลังดูสะอาดกว่าและผ่าน Value.Check ของ TypeBox ดิบ ๆ ได้ แต่ **พังทุกเคสผ่าน Elysia**
 * เพราะ Elysia ปิด additionalProperties ให้ object schema เอง: ใน Intersect ตัว base จะ
 * ปฏิเสธ subLocationId ว่าเป็น property แปลกปลอม และฝั่ง placement ก็ปฏิเสธ requestId
 * กลับ — ไม่มีทางที่ body ไหนจะผ่านทั้งสองก้อนพร้อมกัน
 * (ข้อความที่ได้: "subLocationId: Property 'subLocationId' should not be provided")
 *
 * Composite ยุบสองก้อนเป็น object เดียวก่อน แล้วค่อยให้ union เลือกระหว่างสองรูปที่สมบูรณ์
 * — ไม่มีปัญหาเรื่อง property ข้ามก้อนอีก
 *
 * ⚠️ Elysia ตอบ 400 ไม่ใช่ 422 เมื่อ body ตกด่านนี้
 */
export const createAssetBody = t.Union(
  [t.Composite([createAssetBase, placementOnPlan]), t.Composite([createAssetBase, placementOutOfPlan])],
  {
    // ★ ต้องเขียนเอง — ข้อความมาตรฐานของ union คือ "Value should be one of 'object', 'object'"
    //   ซึ่งไม่บอกอะไรเลยว่าผิดตรงไหนหรือต้องแก้ยังไง (ทั้งสองรูปเป็น object เหมือนกัน)
    error:
      'ที่ตั้งบนผังต้องมาครบชุด: ระบุ subLocationId + ปักหมุด ' +
      'หรือไม่ส่งมาเลยสักช่อง (สำหรับสถานที่ที่อยู่นอกผัง)',
  },
);

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
  /**
   * รับ null ได้ = "ล้างห้องที่เคยเลือกไว้" (คอลัมน์เป็น nullable อยู่แล้ว)
   *
   * ★ เดิมเป็น t.Optional(t.Integer()) เฉย ๆ ซึ่งแยกไม่ออกระหว่าง "ไม่ได้แก้ช่องนี้" กับ
   *   "สั่งให้ลบ" — ปุ่ม "ล้าง" ในฟอร์มส่ง 0 มา ฝั่ง client แปลงเป็น undefined (เพราะ null
   *   ส่งไม่ได้) แล้ว key หายไปจาก JSON ผลคือหมุดถูกล้างแต่ห้องยังอยู่ใน DB พอเปิดกล่อง
   *   ใหม่ getAsset คืนห้องเดิมกลับมา เหมือนกดล้างแล้วไม่มีอะไรเกิดขึ้น
   *
   *   (หลักเดียวกับ imageId/serialNumber ข้างล่างที่รับ null เพื่อสั่งลบได้)
   */
  subLocationId: t.Optional(t.Union([t.Integer({ minimum: 1 }), t.Null()])),
  /**
   * หมุดตำแหน่งบนผังชั้น — รับ null ได้ต่างจากฝั่ง create คือ "ถอนหมุดออกโดยไม่ปักใหม่"
   *
   * ★ ย้ายห้อง (ส่ง subLocationId ใหม่) โดยไม่ส่งสองช่องนี้มาด้วย = service ล้างหมุดให้เอง
   *   ไม่ต้องส่ง null มาเอง — พิกัดเดิมเป็นของผังห้องเก่า เก็บไว้คือหมุดผิดที่
   */
  posX: t.Optional(t.Union([t.Number({ minimum: 0, maximum: 1 }), t.Null()])),
  posY: t.Optional(t.Union([t.Number({ minimum: 0, maximum: 1 }), t.Null()])),
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

/**
 * ที่ตั้งบนผังของชิ้นที่ "ลงทะเบียนแล้ว" — ช่องทางเดียวที่แก้ของ REGISTERED ได้
 *
 * ── ทำไมต้องแยกจาก updateAssetBody ────────────────────────────────────────────
 *
 * update() ปฏิเสธ lifecycle = REGISTERED ทั้งก้อนด้วยเหตุผลว่า "ต้องแก้ที่ SAP" ซึ่งถูกต้อง
 * สำหรับคำอธิบาย/ราคาทุน/แผนก — ของพวกนั้น SAP เป็นเจ้าของและ sync ทับกลับมาทุกรอบ
 *
 * แต่สามช่องนี้ไม่ใช่ของ SAP: OITM ไม่มีข้อมูลที่ตั้งเลย และ upsert ของ asset.connector
 * ก็ไม่ได้ใส่ subLocationId/posX/posY ไว้ใน set: โดยตั้งใจ (เขียนกำกับไว้ว่า "ห้องย่อย/
 * พิกัดหมุด เป็นของที่คนกรอกเองหลังจากนี้ ทับเมื่อไหร่คืองานที่หายไปเงียบ ๆ ทุกรอบ sync")
 * — AMS เป็นเจ้าของข้อมูลนี้ฝ่ายเดียว จึงไม่มีอะไรใน SAP ให้ขัดกัน
 *
 * ★ ไม่รับ null และบังคับครบสามช่อง — ต่างจาก updateAssetBody โดยตั้งใจ
 *
 * ผู้เรียกเส้นนี้มีที่เดียวคือกล่องเลือกสถานที่บนผัง ซึ่งยืนยันไม่ได้ถ้าไม่มีทั้งห้องและหมุด
 * (ดู FloorPlanPickerModal) รูป partial จึงไม่มีทางเกิดจาก UI — และการเปิดให้ส่ง null ได้
 * เท่ากับเปิดทางให้ "ล้างที่ตั้งของชิ้นที่ลงทะเบียนแล้ว" ซึ่งไม่มีใครขอ และเป็นการทำลาย
 * ข้อมูลที่ไม่มีทางกู้กลับ (SAP ไม่มีให้ sync กลับมา)
 *
 * ถ้าวันหลังต้องมี "ถอนที่ตั้ง" ให้เพิ่มเป็นเส้น DELETE แยก ไม่ใช่ทำให้สามช่องนี้ nullable
 */
export const updateAssetLocationBody = t.Object({
  subLocationId: t.Integer({ minimum: 1 }),
  // สัดส่วนของภาพ 0–1 เหมือน updateAssetBody — ck_asset_pos_* ที่ DB คุมช่วงเดียวกัน
  posX: t.Number({ minimum: 0, maximum: 1 }),
  posY: t.Number({ minimum: 0, maximum: 1 }),
});

/**
 * รูปของชิ้นที่ "ลงทะเบียนแล้ว" — เหตุผลชุดเดียวกับ updateAssetLocationBody
 *
 * OITM ไม่มีรูป และ upsert ของ asset.connector ไม่ได้ใส่ imageId ไว้ใน set: (ตรวจแล้ว)
 * — คอลัมน์นี้ AMS เป็นเจ้าของฝ่ายเดียว sync ไม่เคยทับ
 *
 * ★ ไม่รับ null = ไม่มีทาง "ถอดรูปออก" ผ่านเส้นนี้ มีแต่ใส่กับเปลี่ยน
 *
 * รูปคือสิ่งเดียวที่คนหน้างานใช้ยืนยันว่าของตรงหน้าคือชิ้นเดียวกับในทะเบียน (เหตุผลเดียว
 * กับที่ createAssetBody บังคับ imageId ตอนสร้าง) การเปิดให้ลบทิ้งจากกล่องรายละเอียด
 * ซึ่งเป็นหน้าที่ "ใครก็เปิดได้" คือทางที่ของหายโดยไม่มีใครตั้งใจ — ถ้าวันหลังต้องมีจริง
 * ให้ทำเป็นเส้น DELETE แยกที่จำกัดสิทธิ์ต่างหาก
 */
export const updateAssetImageBody = t.Object({
  // id จาก POST /uploads ที่อัปเป็น ASSET_IMG — ไม่รับไฟล์ตรงนี้ (เหมือน createAssetBody)
  imageId: t.String({ format: 'uuid' }),
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

/**
 * เลขเปล่า ๆ ไม่มีบริษัท — ใช้กู้ QR รูปแบบเก่าเท่านั้น (ดู resolveAssetNumber)
 *
 * ★ ไม่ใช่ทางเข้าใหม่สำหรับค้นด้วยเลข: มันตอบได้หลายชิ้นโดยธรรมชาติ ซึ่งเป็นเหตุผลที่
 *   /assets/by-number บังคับ company มาตั้งแต่ 0021 เส้นนี้มีไว้บอกว่า "เลขนี้เป็นของ
 *   บริษัทไหนบ้าง" เพื่อพาไปยัง URL ที่ถูกต้อง ไม่ได้คืนข้อมูลของชิ้นนั้น
 */
export const assetResolveNumberQuery = t.Object({
  number: t.String({ minLength: 1, maxLength: 100 }),
});
