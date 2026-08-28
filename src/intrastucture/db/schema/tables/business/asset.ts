import {
  pgTable,
  pgEnum,
  serial,
  varchar,
  uuid,
  integer,
  numeric,
  date,
  boolean,
  check,
  foreignKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from '@intrastucture/db/schema/shared/iso-timestamp';
import { attachment, enumDocType } from './attachment';
import { grpoLine } from './grpo';
import { company } from './company';
import { assetRequest } from './asset-request';
import { category, assetLocation, assetSubLocation, department, employee } from './master';
import { user } from '@intrastucture/db/schema/user';

// วงจรชีวิตของ "ชิ้น" — คนละแกนกับสถานะของใบคำขอ (ใบตอบแค่ว่าหัวหน้าอนุมัติจำนวนแล้วหรือยัง)
//   DRAFT      รออนุมัติ/รอบัญชีออกเลข
//   REGISTERED บัญชีลงเลขให้แล้ว = อยู่ในทะเบียนของ SAP
//   CANCELLED  บัญชีปิดถาวร (0014) — ของที่รับมาแล้วแต่จะไม่ลงทะเบียน เช่นนับเกิน/ส่งคืน
//
// CANCELLED ไม่ใช่ soft delete: soft delete ในโปรเจกต์นี้แปลว่า "ไม่ควรมีแถวนี้ตั้งแต่แรก"
// แต่การที่บัญชีตัดของทิ้งเป็นการตัดสินใจทางธุรกิจที่ต้องตอบย้อนหลังได้ว่าทำไมของที่รับมา
// 5 ชิ้นถึงลงทะเบียนแค่ 4 — ถ้าลบทิ้งจะไม่เหลืออะไรให้ตอบ
//
// ⚠️ ทุกตัวนับที่ถามว่า "ลงได้อีกกี่ชิ้น" ต้อง **นับ CANCELLED รวมด้วย** (แก้ใน 0016)
// เพราะ cancel แปลว่า "ปิดถาวร" ช่องนั้นไม่คืนให้ใครใช้ต่อ — เดิม (0014) กันออกเพราะ
// ตอนนั้น cancel แปลว่า "ตัดทิ้งแล้วลงใหม่ได้" ซึ่งทับหน้าที่กับการตีกลับรายชิ้น
// หน้าที่แยกกันชัดแล้วตั้งแต่ 0016:
//   asset.rejectedAt  ข้อมูลผิด ให้ผู้ขอแก้แล้วกลับเข้าคิว (ชิ้นเดิม ไม่กินช่องเพิ่ม)
//   CANCELLED         ของจะไม่เป็นสินทรัพย์ ปิดช่องถาวร (ปลดได้เฉพาะบัญชี uncancelAsset)
export const enumAssetLifecycle = pgEnum('asset_lifecycle', ['DRAFT', 'REGISTERED', 'CANCELLED']);

// ชิ้นนี้เข้ามาอยู่ในระบบได้ยังไง — ตัวชี้ขาดว่าโซ่ PO ที่ว่างอยู่ "ว่างเพราะอะไร"
//   PO_FLOW    = เกิดจาก PO -> GRPO -> ใบคำขอ -> ลงทะเบียนผ่าน AMS (โซ่ครบทุกข้อ)
//   SAP_LEGACY = มีอยู่ในบัญชี SAP มาก่อน AMS แค่ดึงมาแสดง (ไม่มีโซ่เลย)
//
// ถ้าดูแค่ NULL จะแยกไม่ออกระหว่าง "ไม่มี PO เพราะเป็นของเก่า" กับ "ควรมี PO แต่ข้อมูล
// หายไป" ซึ่งต้องตามแก้คนละแบบ — คอลัมน์นี้ทำให้ ck_asset_origin_chain บังคับได้ว่า
// แต่ละแบบต้องมี/ต้องไม่มีอะไรบ้าง แทนที่จะเป็นข้อตกลงลอย ๆ ที่โค้ดฝั่งเดียวจำไว้เอง
export const enumAssetOrigin = pgEnum('asset_origin', ['PO_FLOW', 'SAP_LEGACY']);

export const enumAssetStatus = pgEnum('asset_status', [
  'Active',
  'Inactive',
  'Under Maintenance',
  'Lost',
  'Disposed',
]);

export const asset = pgTable(
  'asset',
  {
    id: serial().primaryKey().notNull(),
    // ── โซ่ PO ทั้งชุด (requestId..acquisitionCost) เป็น NULL ได้ตั้งแต่ 0010 เพื่อรับ
    //    สินทรัพย์เก่าที่มีอยู่ใน SAP ก่อน AMS — ดู enumAssetOrigin และ ck_asset_origin_chain
    //    ที่บังคับว่า PO_FLOW ต้องมีครบทุกตัว ส่วน SAP_LEGACY ต้องว่างทั้งชุด
    //    NULL ที่นี่จึงไม่เคยแปลว่า "ลืมกรอก" — มันแปลว่า "ของชิ้นนี้ไม่ได้มาทางจัดซื้อ"
    origin: enumAssetOrigin().default('PO_FLOW').notNull(),
    // บริษัทเจ้าของชิ้นนี้ (0021) — ต้องมีบน asset เอง ไม่ derive จาก PO ย้อนขึ้นไป
    // เพราะสาย SAP_LEGACY ไม่มีโซ่ PO ให้ไต่เลย (requestId..acquisitionCost เป็น NULL ทั้งชุด)
    companyCode: varchar({ length: 20 }).notNull(),
    requestId: integer(),
    grpoLineId: uuid(),
    // copy ลงมาจาก grpo_line เพื่อให้ตั้ง unique (poItemId, unitNo) ได้ — unique ข้ามตารางทำไม่ได้
    // ไม่ใช่ copy ลอย ๆ: composite FK ข้างล่างบังคับให้ตรงกับรอบรับของจริงเสมอ
    poItemId: uuid(),
    // ชิ้นที่เท่าไรของ PO line (นับต่อเนื่องทั้งบรรทัด ข้ามรอบรับของและข้ามใบคำขอ)
    // มีไว้แทนการ "นับแล้วเทียบ" — เพดานกลายเป็นเลขที่ DB กันซ้ำให้เอง ปิด race condition
    unitNo: integer(),
    // ราคาทุนที่ "เสนอ" ตอนขอลงทะเบียน ค่าตั้งต้นจาก purchase_order_item.unitPrice
    // ตรึงไว้ ณ ตอนสร้าง — ราคาที่ลงบัญชีจริงเป็นของ SAP ซึ่งจะ sync มาทีหลังคนละคอลัมน์
    //
    // ฝั่ง SAP_LEGACY ไม่มี "ราคาที่เสนอ" ให้ตรึง — ใช้ยอดจากใบ A/P invoice ตรง ๆ
    // และ NULL ได้จริง (1,220 จาก 2,325 ชิ้นไม่มีใบกำกับเลย จึงไม่รู้ราคา) ซึ่งตรงกว่า 0
    // ที่จะไหลไปเป็นยอดรวมค่าเสื่อมเท่ากับศูนย์บน dashboard โดยไม่มีใครทักท้วง
    acquisitionCost: numeric({ mode: 'number' }),
    acquisitionDate: date(),
    // ── มูลค่าทางบัญชี/ค่าเสื่อม ย้ายออกไปตาราง asset_accounting แล้ว (0020)
    //
    // เดิมมีสี่คอลัมน์อยู่ตรงนี้ (usefulLifeYear / salvageValue / accumulatedDepreciation /
    // netBookValue) ตั้งไว้ตั้งแต่ก่อนสำรวจ SAP จริง แล้วไม่เคยมีใครเขียนลงสักแถว —
    // NULL ครบ 2,351 แถวและไม่มีโค้ดไหนอ้างถึงเลย จึงตัดทิ้งพร้อมกับตอนสร้างตารางใหม่
    //
    // ทำไมต้องเป็นตารางแยก ไม่ใช่คอลัมน์ต่อท้ายที่นี่: ชุดตัวเลขบัญชีมาจาก ITM7+ITM8 ซึ่งเป็น
    // คนละรอบ sync คนละคิวรีกับ OITM และมีของที่ asset ไม่ควรถือ เช่นปีบัญชีของตัวเลขชุดนั้น
    // (ดูหัวไฟล์ของ asset-accounting.ts) ส่วน netBookValue ไม่เก็บที่ไหนทั้งนั้น — SAP เองก็
    // ไม่ได้เก็บ มันคำนวณตอนเปิดรายงาน ให้หน้าจอลบเอาเอง
    //
    // "ดึงมาล่าสุดเมื่อไหร่" อยู่ที่ asset_accounting.syncedAt ไม่ใช่ที่นี่ — พอตารางนั้นเป็น
    // 1 แถวต่อชิ้น มันเป็นคุณสมบัติของแถวข้อมูลบัญชีเอง และ "ไม่มีแถว = ไม่เคย sync"
    // ตอบได้ด้วย LEFT JOIN อยู่แล้ว ไม่ต้องมีคอลัมน์ค้างบน asset ให้ NULL เต็มไปหมด
    // ชิ้นนี้เกิดจากการที่คนแจ้งจำนวนเอง ไม่ได้มาจากตัวเลข SAP ตรง ๆ
    // เป็น snapshot ณ ตอนเกิด (derive จาก asset_request_line ย้อนหลังไม่ได้ เพราะชิ้นแรก
    // ของงานเหมาก็ไม่เกิน quantity เหมือนกัน) ต้องติดตัวไปถึง Dashboard/Audit/บัญชี
    isSplitItem: boolean().default(false).notNull(),
    assetNumber: varchar({ length: 100 }),
    description: varchar({ length: 100 }),
    serialNumber: varchar({ length: 100 }),
    // nullable ตั้งแต่ 0007 — หมวดกับหน่วยนับอยู่ที่ OITM (item master) ของ SAP ไม่ได้อยู่บน PO
    // ตอนคนกรอกฟอร์มลงทะเบียนจึงยังไม่มีทางรู้ ต้องรอ job ที่ map จาก itemCode มาเติมทีหลัง
    // เดิมเป็น NOT NULL ทำให้ POST /assets ได้ 422 ทุกครั้ง (ฟอร์มไม่มีช่องให้กรอกสองตัวนี้)
    // NULL = ยังไม่ได้ map จาก SAP — ชัดกว่าการบังคับให้เลือกมั่ว ๆ ไปก่อนแล้วแก้ทีหลังไม่ได้
    //
    // ตั้งแต่ 0011 connector เติมให้เองจากท่อนแรกของ OITM.AssetClass (ดู category.code)
    categoryId: integer(),
    // รหัสสินทรัพย์ทางบัญชีจาก SAP ทั้งสตริง เช่น '1216401-0-775' — เก็บดิบไม่แปลง (0011)
    //   ท่อน 1 = รหัสบัญชี → categoryId   ท่อน 2 = 0 สำนักงาน / 1 โรงงาน   ท่อน 3 = cost center → departmentId
    // เก็บทั้งก้อนไว้เป็นหลักฐานว่าค่าที่ derive มาสองตัวนั้นมาจากอะไร ตรวจย้อนได้โดยไม่ต้องเปิด SAP
    //
    // ⚠️ เดิม (ก่อน 0011) คอลัมน์นี้เก็บ 3 ตัวอักษรหน้ารหัสสินทรัพย์ (FUR/COM/MAC) ซึ่งเป็น
    // การเดาที่ผิด — ไม่ใช่หมวดอะไรทั้งนั้น ค่าเก่าถูกทับทั้งหมดตอน sync รอบแรกหลัง 0011
    assetClass: varchar({ length: 50 }),
    qrCode: varchar({ length: 255 }),
    // ── ใครออกเลขให้ชิ้นนี้ และเมื่อไหร่ (0019)
    //
    // เก็บแยกจาก updatedBy/updatedAt ด้วยเหตุผลเดียวกับ cancelledBy/rejectedBy: สองช่องนั้น
    // ถูกทับทุกครั้งที่มีคนแก้อะไรก็ตามทีหลัง แล้วจะตอบไม่ได้ว่า "ใครเป็นคนออกเลขให้ชิ้นนี้"
    // ซึ่งเป็นคำถามที่ต้องตอบได้ตลอดอายุของสินทรัพย์ (เลขเข้าทะเบียน SAP แล้วแก้ยาก)
    //
    // ไม่ใช้ asset_request.completedBy แทน: อันนั้นคือคนที่กดปิดงานทั้งใบ ซึ่งเป็นคนละเหตุการณ์
    // และยังว่างอยู่ตลอดช่วงที่บัญชีทยอยออกเลขทีละชิ้น — ช่วงที่คนอยากรู้พอดี
    //
    // ล้างเป็น NULL เมื่อชิ้นถูกตีกลับ (เลขถูกล้างไปด้วย) — ดู rejectAsset
    registeredAt: isoTimestamp(),
    registeredBy: integer(),
    lifecycle: enumAssetLifecycle().default('DRAFT').notNull(),
    status: enumAssetStatus().default('Active').notNull(),
    // หน่วยนับ — คัดลอกจาก OITM.InvntryUom ตรง ๆ ไม่ผ่านตาราง master (0011 ถอด uom/uomId ทิ้ง)
    // ค่าจริงมี 13 แบบ ยาวสุด 7 อักษร (ตัว/เครื่อง/ชิ้น/ชุด/ใบ...) — เหตุผลที่ไม่ทำตารางแยกอยู่ที่ master.ts
    // NULL = SAP ไม่ได้ระบุ (3 จาก 2,325 ชิ้น) หรือชิ้นนั้นมาทาง PO ซึ่งยังไม่มีใครเติมให้
    uom: varchar({ length: 20 }),
    // แผนกที่สินทรัพย์สังกัด (เพิ่มใน 0008) — คนละแกนกับ employeeId
    //
    // ไม่ derive จาก employee.departmentId เพราะสองอย่างนี้เป็นคนละคำถาม:
    //   employeeId  = ใครถือครองอยู่ตอนนี้ (ว่างได้ เช่นของกลางในห้องประชุม)
    //   departmentId = ของก้อนนี้เป็นงบ/ความรับผิดชอบของแผนกไหน (ยังตอบได้แม้ไม่มีผู้ถือครอง)
    // ถ้าดึงจากคน: ของกลางจะไม่มีแผนกเลย และคนย้ายแผนกทีเดียวสินทรัพย์ย้ายตามทั้งกอง
    // ซึ่งผิด — ของยังอยู่ที่แผนกเดิม
    //
    // nullable: ของเก่าที่ลงไว้ก่อน 0008 ยังไม่มีค่า และตอนกรอกอาจยังไม่รู้ว่าจะลงแผนกไหน
    departmentId: integer(),
    employeeId: integer(),
    locationId: integer().notNull(),
    subLocationId: integer(),
    // ── ตำแหน่งบนผังห้อง (เพิ่มใน 0007) — จุดที่ผู้ใช้ปักหมุดว่าของชิ้นนี้วางตรงไหน
    //
    // เก็บเป็น "สัดส่วนของภาพ" 0–1 ไม่ใช่ pixel: pixel มีความหมายเฉพาะกับภาพขนาดเดิม
    // เท่านั้น วันที่สแกนผังใหม่ด้วยความละเอียดต่างไป หมุดทุกตัวจะเลื่อนผิดที่พร้อมกัน
    // แบบเงียบ ๆ ส่วนสัดส่วนแปลว่า "41.2% จากซ้าย 88.8% จากบน" ซึ่งถูกเสมอทุกขนาดภาพ
    // และ frontend คำนวณแค่ posX * ความกว้างที่เรนเดอร์จริง
    //
    // ⚠️ รอดการ "ย่อ/ขยาย" แต่ไม่รอดการ "ครอปใหม่" — เปลี่ยนผังเป็นรูปคนละกรอบต้องปักใหม่
    // numeric(6,5): พอสำหรับ 0–1 ละเอียด 5 ตำแหน่ง (ต่ำกว่า 1 พิกเซลบนภาพกว้าง 10,000px)
    posX: numeric({ precision: 6, scale: 5, mode: 'number' }),
    posY: numeric({ precision: 6, scale: 5, mode: 'number' }),
    // ── ร่องรอยการตัดของทิ้งโดยบัญชี (0014) — คู่กับ lifecycle = 'CANCELLED'
    // เก็บสามช่องแยกจาก updatedBy/updatedAt ที่จะถูกทับทุกครั้งที่มีคนแก้อะไรก็ตามทีหลัง
    // (หลักเดียวกับ deletedAt/deletedBy) — ถ้าไม่มี ก็ตอบไม่ได้ว่าใครตัดทิ้งเมื่อไหร่เพราะอะไร
    // ซึ่งเป็นเหตุผลเดียวที่ CANCELLED มีอยู่แทนการลบทิ้ง
    cancelReason: varchar({ length: 500 }),
    cancelledAt: isoTimestamp(),
    cancelledBy: integer(),
    // ── ร่องรอยการตีกลับ "รายชิ้น" โดยบัญชี (0016)
    //
    // คนละอย่างกับ asset_request.rejectedBy/rejectReason ซึ่งเป็นการตีกลับ "ทั้งใบ" ของหัวหน้า:
    //   ตีกลับทั้งใบ  = ใบยังไม่ผ่านการอนุมัติ ทุกชิ้นในใบต้องแก้
    //   ตีกลับรายชิ้น = ใบผ่านอนุมัติแล้ว แต่บัญชีเจอปัญหาเฉพาะชิ้นนี้ (S/N ผิด รูปไม่ชัด ที่ตั้งไม่ตรง)
    //                  ชิ้นอื่นในใบเดียวกันเดินหน้าออกเลขต่อได้ตามปกติ
    //
    // ไม่ทำเป็นค่าใหม่ใน lifecycle โดยตั้งใจ — ชิ้นที่ถูกตีกลับยังเป็น "งานที่ยังไม่จบ" เหมือนเดิม
    // ตัวนับที่ถามว่า "เหลือกี่ชิ้นที่ยังไม่มีเลข" (lifecycle = 'DRAFT') จึงต้องนับมันต่อไป
    // ถ้าแยกเป็น lifecycle ใหม่ ชิ้นที่ถูกตีกลับจะหลุดจากตัวนับพวกนั้นทั้งหมด แล้วใบจะถูก
    // ปิดว่า "ออกเลขครบแล้ว" ทั้งที่ยังมีชิ้นค้างรอแก้อยู่
    //
    // ล้างทั้งชุดเมื่อผู้ใช้แก้ชิ้นนั้นแล้ว (ดู update() ใน asset.service) = ส่งกลับเข้าคิวบัญชีอีกครั้ง
    rejectedAt: isoTimestamp(),
    rejectedBy: integer(),
    rejectReason: varchar({ length: 500 }),
    // ชื่อ role ณ ตอนกด ไม่ใช่ FK ไป role — snapshot ด้วยเหตุผลเดียวกับ assignedManagerId:
    // role ของคนเปลี่ยนได้ทีหลัง ถ้าไปอ่าน role ปัจจุบันของ rejectedBy ตอนแสดงผล ประวัติจะ
    // เพี้ยนย้อนหลัง ("finance ตีกลับ" กลายเป็น "manager ตีกลับ" เพราะคนนั้นย้ายตำแหน่ง)
    rejectedRole: varchar({ length: 50 }),
    /**
     * เวลาที่ผู้ขอ "แก้ชิ้นที่ถูกตีกลับเสร็จ" — คู่ตรงข้ามของ rejectedAt
     *
     * ต้องมีคอลัมน์แยกเพราะ update() ล้าง rejectedAt ทั้งชุดตอนผู้ขอแก้ (ตั้งใจ ไม่งั้นชิ้นจะ
     * ค้างสถานะตีกลับตลอดกาล) พอล้างแล้วบัญชีก็แยกไม่ออกว่าชิ้นไหนคือ "ของที่เคยตีกลับและ
     * แก้กลับมาแล้ว" กับ "ของปกติที่ไม่เคยมีปัญหา" ซึ่งคนละความหมายตอนตรวจก่อนออกเลข
     * — updatedAt/updatedBy ใช้แทนไม่ได้ มันถูกทับทุกครั้งที่มีคนแก้อะไรก็ตาม
     *
     * NULL อีกครั้งเมื่อ "งานรอบนั้นจบ": ออกเลข / ปิดถาวร / ถูกตีกลับซ้ำ — ป้าย "แก้ไขแล้ว"
     * จึงหมายถึงรอบที่ยังค้างอยู่เท่านั้น ไม่ใช่ตราประทับถาวรบนชิ้น
     */
    rejectFixedAt: isoTimestamp(),
    warrantyStartDate: isoTimestamp(),
    warrantyEndDate: isoTimestamp(),
    imageId: uuid(),
    imageDocType: enumDocType().generatedAlwaysAs(sql`'ASSET_IMG'::doc_type`),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    // ทั้งสามคอลัมน์อ่านจาก token (currentUser.id) เท่านั้น ห้ามรับจาก body — เดิมเป็น varchar
    // ที่ client ส่งชื่อใครมาก็ได้ ทำให้ audit trail ของสินทรัพย์เชื่อถือไม่ได้เลย
    //
    // NULL = ไม่มีมนุษย์เป็นคนสร้าง แถวนี้มาจาก sync ของ SAP (ดู asset.connector.ts)
    // เลือกทางนี้แทนการตั้ง user ปลอมชื่อ SYSTEM เพราะ user ปลอมต้องมี role/รหัสผ่าน/
    // employee จริง ๆ แล้วจะโผล่ใน dropdown ผู้ถือครองและรายชื่อผู้อนุมัติไปด้วย
    // ck_asset_origin_chain ยังบังคับให้ฝั่ง PO_FLOW ต้องมีคนจริงเสมอ audit ไม่ได้อ่อนลง
    createdBy: integer(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedBy: integer(),

    deletedAt: isoTimestamp(),
    deletedBy: integer(),
  },
  (table) => [
    foreignKey({
      columns: [table.requestId],
      foreignColumns: [assetRequest.id],
      name: 'fk_asset_request',
    }),
    // composite FK — ครอบ grpoLineId ไปในตัว (ไม่ต้องมี FK คอลัมน์เดียวซ้ำอีก) และบังคับว่า
    // poItemId ที่ copy ลงมาต้องเป็นของรอบรับของแถวนั้นจริง ยัดเลขมั่วเข้ามา DB ปฏิเสธเอง
    foreignKey({
      columns: [table.grpoLineId, table.poItemId],
      foreignColumns: [grpoLine.id, grpoLine.poItemId],
      name: 'fk_asset_grpo_line',
    }),
    // composite FK — imageId ชี้ไปแถว INVOICE ไม่ได้ DB ปฏิเสธเอง
    foreignKey({
      columns: [table.imageId, table.imageDocType],
      foreignColumns: [attachment.id, attachment.docType],
      name: 'fk_asset_image',
    }),
    // FK ไป master — ไม่ cascade: ลบ category ที่มี asset ใช้อยู่ไม่ได้ ต้องปิด isActive แทน
    foreignKey({
      columns: [table.categoryId],
      foreignColumns: [category.id],
      name: 'fk_asset_category',
    }),
    foreignKey({
      columns: [table.locationId],
      foreignColumns: [assetLocation.id],
      name: 'fk_asset_location',
    }),
    foreignKey({
      columns: [table.subLocationId],
      foreignColumns: [assetSubLocation.id],
      name: 'fk_asset_sub_location',
    }),
    foreignKey({
      columns: [table.employeeId],
      foreignColumns: [employee.id],
      name: 'fk_asset_employee',
    }),
    // ไม่ cascade เหมือน FK master ตัวอื่น — ลบแผนกที่มีสินทรัพย์สังกัดอยู่ไม่ได้ ต้องปิด isActive
    foreignKey({
      columns: [table.departmentId],
      foreignColumns: [department.id],
      name: 'fk_asset_department',
    }),
    // ผู้ทำรายการ — ไม่ cascade: ลบ user ที่เคยลงทะเบียนสินทรัพย์ไม่ได้ ต้องปิด isActive แทน
    // (ประวัติว่าใครลงทะเบียน/แก้/ลบ ต้องอยู่ตลอดอายุสินทรัพย์ — วัตถุประสงค์ข้อ 4 ของโปรเจกต์)
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [user.id],
      name: 'fk_asset_created_by',
    }),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_updated_by',
    }),
    foreignKey({
      columns: [table.deletedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_deleted_by',
    }),
    foreignKey({
      columns: [table.cancelledBy],
      foreignColumns: [user.id],
      name: 'fk_asset_cancelled_by',
    }),
    foreignKey({
      columns: [table.registeredBy],
      foreignColumns: [user.id],
      name: 'fk_asset_registered_by',
    }),
    foreignKey({
      columns: [table.rejectedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_rejected_by',
    }),
    // ตีกลับต้องมีเหตุผลและมีเจ้าของเสมอ — สามช่องนี้ต้องมาพร้อมกันหรือว่างทั้งชุด
    // ไม่มี CHECK ตัวนี้ = ล้างไม่ครบตอนผู้ใช้แก้ชิ้นแล้วเหลือ rejectReason ค้าง ซึ่งจะโผล่
    // เป็นข้อความ "ถูกตีกลับเพราะ..." บนชิ้นที่แก้ไปแล้วโดยไม่มีอะไรฟ้อง
    check(
      'ck_asset_reject_trio',
      sql`(${table.rejectedAt} IS NULL) = (${table.rejectedBy} IS NULL)
          AND (${table.rejectedAt} IS NULL) = (${table.rejectReason} IS NULL)`,
    ),
    // ชิ้นที่ลงทะเบียนกับ SAP แล้วหรือถูกปิดถาวรแล้ว ตีกลับไม่ได้ — ไม่มีใครแก้แล้วส่งใหม่ได้อีก
    // ป้ายบนจอจึงต้องไม่มีทางขึ้น "Rejected" ทับ Registered/Cancelled ตั้งแต่ระดับข้อมูล
    check(
      'ck_asset_reject_only_draft',
      sql`${table.rejectedAt} IS NULL OR ${table.lifecycle} = 'DRAFT'`,
    ),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอนกรองตามหมวด/สถานที่/ผู้ถือครองใน Dashboard
    index('idx_asset_category_id').on(table.categoryId),
    index('idx_asset_location_id').on(table.locationId),
    index('idx_asset_employee_id').on(table.employeeId),
    // "สินทรัพย์ของแผนกนี้มีอะไรบ้าง" คือคำถามหลักของรายงาน — ต้องมี index ไม่งั้นสแกนทั้งตาราง
    index('idx_asset_department_id').on(table.departmentId),
    // ใช้ตอน join/นับ asset ของคำขอ และของรอบรับของ
    index('idx_asset_request_id').on(table.requestId),
    index('idx_asset_grpo_line_id').on(table.grpoLineId),
    // ใช้ตอบ "ของที่ user คนนี้ลงทะเบียนไว้" และตอนตรวจสอบย้อนหลังว่าใครแก้/ลบ
    index('idx_asset_created_by').on(table.createdBy),
    index('idx_asset_updated_by').on(table.updatedBy),
    index('idx_asset_deleted_by').on(table.deletedBy),
    // เลข SAP ต้องไม่ซ้ำ — pg ยอมหลาย NULL อยู่แล้ว (ช่วง DRAFT ยังไม่มีเลข)
    // partial WHERE deletedAt IS NULL: asset ที่ลบแล้วต้องคืนเลข SAP ให้ใช้ซ้ำได้ (ในบัญชีเลขนั้นว่างแล้ว)
    //
    // เติม companyCode เข้าคีย์ใน 0021 — เลขสินทรัพย์ (OITM.ItemCode) ชนกันข้ามบริษัทจริง
    // วัดแล้ว 24 ตัวที่ UBP ใช้เลขเดียวกับของ UBA ที่มีอยู่แล้ว ถ้าไม่เติม import UBP
    // จะ fail 24 แถว ส่วนเลขในบริษัทเดียวกันยังห้ามซ้ำเหมือนเดิมทุกประการ
    uniqueIndex('uq_asset_number')
      .on(table.companyCode, table.assetNumber)
      .where(sql`${table.deletedAt} IS NULL`),
    foreignKey({
      columns: [table.companyCode],
      foreignColumns: [company.code],
      name: 'fk_asset_company',
    }),
    index('idx_asset_company_code').on(table.companyCode),
    // ใช้ตอนนับ/กรองรายชิ้นต่อ PO line โดยไม่ต้อง join grpo_line ก่อนทุกครั้ง
    index('idx_asset_po_item_id').on(table.poItemId),
    // ★ หัวใจของการคุมจำนวน: เลขชิ้นห้ามซ้ำในบรรทัดเดียวกัน
    // แทนการ "นับแล้วเทียบเพดาน" ซึ่งยิงพร้อมกันสองครั้งแล้วเกินได้ (อ่านยอดเดิมทั้งคู่)
    // partial: ชิ้นที่ถูก soft delete แล้วต้องคืนเลขให้ชิ้นใหม่ใช้ต่อได้
    uniqueIndex('uq_asset_po_item_unit_no')
      .on(table.poItemId, table.unitNo)
      .where(sql`${table.deletedAt} IS NULL`),
    // 1 ไฟล์รูป = 1 ชิ้น ห้ามใช้ร่วม — เปลี่ยนรูปต้องอัปไฟล์ใหม่แล้วสลับ imageId
    // (ห้ามเขียนทับไฟล์เดิมบน disk: browser cache ค้าง + ทำลายหลักฐานรูปตอนรับของ)
    uniqueIndex('uq_asset_image').on(table.imageId),
    // qrCode ห้ามซ้ำในชิ้นที่ยังใช้งาน — สแกนตอน Audit จะได้ไม่ชี้ผิดชิ้นแล้วบันทึกสถานะ/สถานที่ผิด
    // partial: ชิ้นที่ soft delete แล้วต้องคืน code ให้ชิ้นใหม่ใช้ต่อได้ (เหมือน uq_asset_number/unit_no)
    uniqueIndex('uq_asset_qr_code').on(table.qrCode).where(sql`${table.deletedAt} IS NULL`),
    // ── กติกาของหมุดตำแหน่ง (0007) — บังคับที่ DB เพราะ service เดียวไม่ใช่ทางเข้าเดียว
    //    (import script / job / คนแก้ผ่าน studio เขียนตรงได้หมด)
    //
    // มีคู่หรือไม่มีเลย: พิกัดข้างเดียวไม่มีความหมาย วาดหมุดก็ไม่ได้ ลบทิ้งก็ไม่กล้า
    check('ck_asset_pos_pair', sql`(${table.posX} IS NULL) = (${table.posY} IS NULL)`),
    // อยู่ในกรอบภาพ: หลุด 0–1 เมื่อไหร่ = หมุดวาดออกนอกรูป มองไม่เห็นและลบไม่ถูก
    check(
      'ck_asset_pos_range',
      sql`(${table.posX} IS NULL OR ${table.posX} BETWEEN 0 AND 1)
          AND (${table.posY} IS NULL OR ${table.posY} BETWEEN 0 AND 1)`,
    ),
    // ปักหมุดได้ต้องรู้ก่อนว่าห้องไหน — พิกัดลอย ๆ ที่ไม่รู้ว่าอยู่บนผังใบไหนคือขยะ
    // ⚠️ service ต้องล้าง posX/posY ทุกครั้งที่ subLocationId เปลี่ยน (CHECK ตัวนี้จับให้ไม่ได้:
    //    ย้ายห้องแล้วพิกัดเดิมยังผ่านเงื่อนไข แต่มันชี้ตำแหน่งบนผังของห้องเก่า)
    check(
      'ck_asset_pos_needs_sub_location',
      sql`${table.posX} IS NULL OR ${table.subLocationId} IS NOT NULL`,
    ),
    // ── กติกาที่ทำให้การเปิดโซ่ PO ให้ว่างได้ (0010) ไม่กลายเป็นรูรั่ว
    //
    // ถ้ามีแต่ DROP NOT NULL เฉย ๆ บั๊กฝั่ง PO flow ที่ลืมส่ง grpoLineId จะกลายเป็นแถวที่
    // insert ผ่านเงียบ ๆ แล้วนับจำนวนต่อ PO line เพี้ยนโดยไม่มีอะไรฟ้อง — CHECK ตัวนี้
    // ทำให้ "ว่างได้" มีความหมายเดียวคือ SAP_LEGACY เท่านั้น
    //
    // ฝั่ง SAP_LEGACY บังคับ assetNumber เพราะเป็นคีย์เดียวที่ผูกแถวกลับไปหา SAP ได้
    // (connector upsert ที่คอลัมน์นี้ ไม่มีเลข = จับคู่ไม่ได้ = สร้างซ้ำทุกรอบ)
    // ส่วน acquisitionCost จงใจไม่อยู่ในเงื่อนไขฝั่งนี้ — ของเก่าที่ไม่มีใบกำกับไม่รู้ราคาจริง
    check(
      'ck_asset_origin_chain',
      sql`(${table.origin} = 'PO_FLOW'
             AND ${table.requestId} IS NOT NULL
             AND ${table.grpoLineId} IS NOT NULL
             AND ${table.poItemId} IS NOT NULL
             AND ${table.unitNo} IS NOT NULL
             AND ${table.acquisitionCost} IS NOT NULL
             AND ${table.createdBy} IS NOT NULL
             AND ${table.updatedBy} IS NOT NULL)
          OR (${table.origin} = 'SAP_LEGACY'
             AND ${table.requestId} IS NULL
             AND ${table.grpoLineId} IS NULL
             AND ${table.poItemId} IS NULL
             AND ${table.unitNo} IS NULL
             AND ${table.assetNumber} IS NOT NULL)`,
    ),
    // ── ลงทะเบียนแล้วต้องมีเลข (0013)
    //
    // REGISTERED แปลว่า "อยู่ในทะเบียนสินทรัพย์ของ SAP แล้ว" ซึ่งเป็นไปไม่ได้เลยถ้าไม่มีเลข
    // — เลขคือสิ่งเดียวที่ผูกแถวนี้กลับไปหา SAP ได้ ถ้าไม่มีก็ไม่มีทางรู้ว่าหมายถึงชิ้นไหน
    //
    // ck_asset_origin_chain บังคับ assetNumber ไว้เฉพาะฝั่ง SAP_LEGACY (เพราะ connector
    // upsert ด้วยคอลัมน์นั้น) ฝั่ง PO_FLOW จึงเคยตั้ง REGISTERED ทั้งที่ไม่มีเลขได้
    // บังคับที่ DB ไม่ใช่แค่ที่ service ด้วยเหตุผลเดิมของไฟล์นี้ — service ไม่ใช่ทางเข้าเดียว
    check(
      'ck_asset_registered_needs_number',
      sql`${table.lifecycle} <> 'REGISTERED' OR ${table.assetNumber} IS NOT NULL`,
    ),
    // dashboard/รายงานต้องกรอง 2,325 แถวของเก่าออกได้โดยไม่สแกนทั้งตาราง
    index('idx_asset_origin').on(table.origin),
  ],
);
