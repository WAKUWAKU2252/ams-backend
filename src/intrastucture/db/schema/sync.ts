// ═══════════════════════════════════════════════════════════════════════════
// ตารางคุมงานดึงข้อมูลจาก SAP — คู่ state/event ต่อ entity ตาม naming ของระบบเดิม
// (sap_<entity>_sync / sap_<entity>_sync_event) เปิดตารางเดียวเห็นความคืบหน้า
// ของ entity นั้นทันที ไม่ต้อง filter ด้วยคอลัมน์ entity ทุกครั้ง
//
// ต่างจาก sap_*_sync ชุดเดิมใน core_business: ชุดนั้นเป็น push/outbox (request_payload,
// operation CREATE/UPDATE, retry, workflow_status) เพราะเขาดันเอกสารเข้า SAP
// ของเราเป็น pull อ่านอย่างเดียว จึงเหลือแค่สองเรื่อง — ดึงถึงไหนแล้ว (state)
// กับแต่ละรอบเกิดอะไร (event) ไม่มี payload ดิบให้ดูแล
//
// ตารางพวกนี้ไม่ได้เก็บข้อมูล PO/GRPO — ตัวข้อมูลลง purchase_order/grpo ตามเดิม
// ที่นี่เก็บแค่ "ที่คั่นหน้า" ซึ่งเป็นสิ่งที่ทำให้ไม่ต้อง scan SAP ทั้งก้อนทุกรอบ
// (OPOR ~21,000 / OPDN ~19,000 แถว การดึงเต็มทุก 2 ชม. คือรีดคอ DB ของบริษัท)
// ═══════════════════════════════════════════════════════════════════════════
import {
  pgTable,
  pgEnum,
  serial,
  integer,
  numeric,
  varchar,
  date,
  text,
  index,
  primaryKey,
  foreignKey,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from './shared/iso-timestamp';
// ผูก FK ไปที่ตาราง asset โดยตรง — asset.ts ไม่ได้ import ไฟล์นี้ จึงไม่เกิดวงกลม
import { asset } from './tables/business/asset';
import { company } from './tables/business/company';

// ต้อง export — drizzle-kit อ่านเฉพาะ export ตอน generate ไม่งั้นไม่สร้าง CREATE TYPE ให้
export const enumSyncTrigger = pgEnum('sync_trigger', ['BUTTON', 'SCHEDULED']);
export const enumSyncStatus = pgEnum('sync_status', ['IDLE', 'RUNNING', 'SUCCESS', 'FAILED']);
// BACKFILL = ยังไล่เก็บอดีตอยู่ / INCREMENTAL = เก็บครบแล้ว เหลือแต่ตามของใหม่
export const enumSyncMode = pgEnum('sync_mode', ['BACKFILL', 'INCREMENTAL']);

// ───────────────────────────────────────────────────────────────────────────
// Purchase Order (OPOR/POR1)
// ───────────────────────────────────────────────────────────────────────────
export const sapPurchaseOrderSync = pgTable(
  'sap_purchase_order_sync',
  {
    // ── หนึ่งแถวต่อหนึ่งบริษัท (0021) ────────────────────────────────────────
    // เดิมเป็น singleton: id smallint PK default 1 + CHECK (id = 1) ซึ่งบังคับให้มี
    // watermark ชุดเดียวทั้งระบบ — รองรับสองบริษัทไม่ได้เลยโดยโครงสร้าง
    //
    // เจตนาเดิมยังอยู่ครบ: PK เป็น companyCode ทำให้ยังมี watermark ได้แถวเดียว
    // **ต่อบริษัท** เผลอ insert ซ้ำก็ชน PK เหมือนที่ CHECK เคยกันไว้
    companyCode: varchar({ length: 20 }).primaryKey().notNull(),

    // ── ขอบหน้า: ตามของใหม่/ที่เพิ่งถูกแก้ใน SAP
    // ค่า OPOR.UpdateDate ล่าสุดที่ commit สำเร็จ — ไม่ใช่เวลาที่ job รัน
    // (นาฬิกา AMS กับ SAP ไม่ตรงกัน + แถวอาจถูกแก้ด้วย UpdateDate ย้อนกว่าเวลารัน
    //  ยึดเวลารันเป็นเกณฑ์เมื่อไหร่ = แถวหายโดยไม่มีใครรู้)
    // (ไม่มีคอลัมน์ tiebreak: หน้าต่างขอบหน้าใช้ >= แบบ inclusive อยู่แล้ว แถวที่ UpdateDate
    //  ชนขอบพอดีจึงถูกดึงซ้ำทุกรอบแล้ว upsert ทับ — ไม่ต้องมีตัวตัดสินเพิ่ม)
    lastUpdateDate: isoTimestamp(),

    // ── ขอบหลัง: ไล่เก็บอดีตแบบถอยหลังทีละหน้าต่าง (ดูหมายเหตุ backfill ท้ายไฟล์)
    // ถอยเก็บถึงวันไหนแล้ว = ขอบล่างของหน้าต่างล่าสุด NULL = ยังไม่เริ่ม (รอบแรกเริ่มจากปัจจุบัน)
    backfillCursor: isoTimestamp(),
    // จุดหยุด — MIN(UpdateDate) ของฝั่ง SAP ที่ถามครั้งเดียวตอนรอบแรก
    // ถอยถึงค่านี้เมื่อไหร่ = เก็บครบแล้ว สลับ mode เป็น INCREMENTAL
    backfillFloor: isoTimestamp(),
    mode: enumSyncMode().default('BACKFILL').notNull(),

    // เวลาที่ job รันล่าสุด — ใช้โชว์/monitor เท่านั้น ห้ามเอาไปคิด delta (เหตุผลข้างบน)
    lastRunAt: isoTimestamp(),
    lastStatus: enumSyncStatus().default('IDLE').notNull(),
    // error ล่าสุด — ดูสถานะปัจจุบันได้โดยไม่ต้องไปไล่ event
    lastError: text(),

    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.companyCode],
      foreignColumns: [company.code],
      name: 'fk_sap_purchase_order_sync_company',
    }),
  ],
);

export const sapPurchaseOrderSyncEvent = pgTable(
  'sap_purchase_order_sync_event',
  {
    id: serial().primaryKey().notNull(),
    // รอบนี้เป็นของบริษัทไหน (0021) — ไม่มีคอลัมน์นี้จะไล่ประวัติแล้วแยกไม่ออก
    // ว่ารอบไหนของใคร โดยเฉพาะตอนสองบริษัท sync สลับกันถี่ ๆ
    companyCode: varchar({ length: 20 }).notNull(),

    // ปุ่มกับ scheduler เรียก engine ตัวเดียวกัน — เก็บไว้ว่ารอบนี้ใครสั่ง
    trigger: enumSyncTrigger().notNull(),
    // user ที่กดปุ่ม / NULL = scheduled ไม่มีคนสั่ง
    // ไม่ทำ FK ไป user โดยตั้งใจ: ตารางนี้ append-only ต้องอยู่รอดแม้ user ถูกลบ
    triggeredBy: integer(),
    // รอบนี้อยู่ช่วง backfill หรือ incremental — ไล่ดูความคืบหน้าย้อนหลังได้
    mode: enumSyncMode().notNull(),

    startedAt: isoTimestamp().default(sql`now()`).notNull(),
    finishedAt: isoTimestamp(),

    // ช่วง UpdateDate ที่รอบนี้กิน — สาวได้ว่าแถวที่หายอยู่รอบไหน
    watermarkFrom: isoTimestamp(),
    watermarkTo: isoTimestamp(),

    // เก็บแค่จำนวน ไม่เก็บ payload ดิบ — ข้อมูลจัดซื้อเป็นข้อมูลบริษัท
    // log ไม่ควรกลายเป็นสำเนาอีกชุดที่ไม่มีใครดูแล
    rowsHeader: integer().default(0).notNull(),
    rowsLine: integer().default(0).notNull(),
    // แถวที่ดึงมาแล้วเขียนลงตารางหลักไม่ได้ — เป็นการ "ตัดถาวร" ไม่ใช่คิวที่รอได้
    // (GRPO ที่ PO แม่ยังไม่ถูก sync ถูกซ่อมในรอบเดียวกันแล้ว ไม่มีทางตกมาถึงตัวนี้)
    // รายละเอียดว่าใบไหน/เพราะอะไร อยู่ในตาราง sap_grpo_unlinked ท้ายไฟล์
    rowsSkipped: integer().default(0).notNull(),

    // ── เวลาที่ใช้ แยกตามเฟส (ดูเหตุผลการแบ่งเฟสที่ sync.engine.ts)
    // sapMs = ช่วงที่คุยกับ SAP (นอกทรานแซกชัน) — ไต่ขึ้นเรื่อย ๆ = SAP ช้าลง
    // txMs  = ช่วงที่ทรานแซกชันเปิดค้าง จับ ams_db ไว้ — ตัวนี้คือตัวที่ต้องเฝ้า เพราะ
    //         ทั้งระบบออกแบบมาให้มันสั้น ถ้าไต่ขึ้นแปลว่าคนใช้งานเริ่มโดนบล็อกตาม
    //         (วัดถึงก่อน COMMIT — เวลา commit จริงไม่รวม แต่เป็นหลักมิลลิวินาที)
    sapMs: integer(),
    txMs: integer(),

    status: enumSyncStatus().notNull(),
    error: text(),
  },
  (table) => [
    // หน้า monitor เปิดมาดูรอบล่าสุดเป็นค่าเริ่มต้นเสมอ
    index('idx_sap_purchase_order_sync_event_started_at').on(table.startedAt),
    // ไล่หาเฉพาะรอบที่พัง
    index('idx_sap_purchase_order_sync_event_status').on(table.status),
  ],
);

// ───────────────────────────────────────────────────────────────────────────
// GRPO (OPDN/PDN1) — โครงเดียวกับ PO ทุกคอลัมน์โดยตั้งใจ
// engine ตัวเดียวทำงานกับทั้งคู่ได้ ต่างกันแค่ SQL ฝั่ง SAP กับตารางปลายทาง
// ───────────────────────────────────────────────────────────────────────────
export const sapGrpoSync = pgTable(
  'sap_grpo_sync',
  {
    // หนึ่งแถวต่อบริษัท (0021) — เหตุผลเดียวกับ sapPurchaseOrderSync
    companyCode: varchar({ length: 20 }).primaryKey().notNull(),
    // OPDN.UpdateDate — GRPO ต้องมี PO แม่อยู่ก่อนเสมอ เพราะ grpo_line ต้อง resolve
    // poItemId (uuid ฝั่ง AMS) จาก purchase_order_item ที่ sync มาแล้ว
    // ระหว่าง backfill ถอยหลัง GRPO เดือนนี้อาจอ้าง PO ที่ยังถอยไปไม่ถึง
    // → connector ต้องดึง PO ใบนั้นเฉพาะใบมาก่อน ไม่ใช่รอให้ backfill เดินมาถึง
    lastUpdateDate: isoTimestamp(),
    backfillCursor: isoTimestamp(),
    backfillFloor: isoTimestamp(),
    mode: enumSyncMode().default('BACKFILL').notNull(),
    lastRunAt: isoTimestamp(),
    lastStatus: enumSyncStatus().default('IDLE').notNull(),
    lastError: text(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.companyCode],
      foreignColumns: [company.code],
      name: 'fk_sap_grpo_sync_company',
    }),
  ],
);

export const sapGrpoSyncEvent = pgTable(
  'sap_grpo_sync_event',
  {
    id: serial().primaryKey().notNull(),
    // รอบนี้เป็นของบริษัทไหน (0021) — ไม่มีคอลัมน์นี้จะไล่ประวัติแล้วแยกไม่ออก
    // ว่ารอบไหนของใคร โดยเฉพาะตอนสองบริษัท sync สลับกันถี่ ๆ
    companyCode: varchar({ length: 20 }).notNull(),
    trigger: enumSyncTrigger().notNull(),
    triggeredBy: integer(),
    mode: enumSyncMode().notNull(),
    startedAt: isoTimestamp().default(sql`now()`).notNull(),
    finishedAt: isoTimestamp(),
    watermarkFrom: isoTimestamp(),
    watermarkTo: isoTimestamp(),
    rowsHeader: integer().default(0).notNull(),
    rowsLine: integer().default(0).notNull(),
    rowsSkipped: integer().default(0).notNull(),
    sapMs: integer(),
    txMs: integer(),
    status: enumSyncStatus().notNull(),
    error: text(),
  },
  (table) => [
    index('idx_sap_grpo_sync_event_started_at').on(table.startedAt),
    index('idx_sap_grpo_sync_event_status').on(table.status),
  ],
);

// ───────────────────────────────────────────────────────────────────────────
// สินทรัพย์เก่าจาก SAP (OITM กลุ่ม 117 รหัสรูปแบบ XXX-###-##-### + ใบ A/P invoice)
//
// โครงเดียวกับสองตัวบนเพื่อให้ engine ตัวเดิมใช้ได้ไม่ต้องแตะ แต่ความหมายต่างกัน:
// entity นี้ไม่มี backfill เพราะ "ประวัติ" ของ item master คือสถานะปัจจุบันของมันเอง
// ไม่ใช่กองเอกสารที่ทยอยเกิดตามเวลา — 2,325 แถวดึงเต็มทุกรอบยังเบากว่าหน้าต่างเดียว
// ของ PO เสียอีก จึงไม่ต้องซอยเวลาให้เสียเที่ยว
//
// ผลคือ backfillCursor จะเป็น NULL ตลอด และ mode สลับเป็น INCREMENTAL ตั้งแต่รอบแรก
// (backfillFloor ถูกปักไว้ที่ "ตอนนี้" ครั้งเดียวแปลว่า "ไม่มีอดีตให้ตามเก็บ")
// — สองคอลัมน์นั้นไม่ได้พัง แต่ไม่มีอะไรให้เล่าสำหรับ entity นี้
// ───────────────────────────────────────────────────────────────────────────
export const sapAssetSync = pgTable(
  'sap_asset_sync',
  {
    // หนึ่งแถวต่อบริษัท (0021) — เหตุผลเดียวกับ sapPurchaseOrderSync
    companyCode: varchar({ length: 20 }).primaryKey().notNull(),
    // OITM.UpdateDate สูงสุดที่เห็น — เก็บไว้ให้หน้าจอบอกได้ว่า "ข้อมูลสดถึงเมื่อไหร่"
    // ไม่ได้ใช้ตัดหน้าต่างเหมือนสอง entity บน (ดึงเต็มทุกรอบอยู่แล้ว)
    lastUpdateDate: isoTimestamp(),
    backfillCursor: isoTimestamp(),
    backfillFloor: isoTimestamp(),
    mode: enumSyncMode().default('BACKFILL').notNull(),
    lastRunAt: isoTimestamp(),
    lastStatus: enumSyncStatus().default('IDLE').notNull(),
    lastError: text(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.companyCode],
      foreignColumns: [company.code],
      name: 'fk_sap_asset_sync_company',
    }),
  ],
);

export const sapAssetSyncEvent = pgTable(
  'sap_asset_sync_event',
  {
    id: serial().primaryKey().notNull(),
    // รอบนี้เป็นของบริษัทไหน (0021) — ไม่มีคอลัมน์นี้จะไล่ประวัติแล้วแยกไม่ออก
    // ว่ารอบไหนของใคร โดยเฉพาะตอนสองบริษัท sync สลับกันถี่ ๆ
    companyCode: varchar({ length: 20 }).notNull(),
    trigger: enumSyncTrigger().notNull(),
    triggeredBy: integer(),
    mode: enumSyncMode().notNull(),
    startedAt: isoTimestamp().default(sql`now()`).notNull(),
    finishedAt: isoTimestamp(),
    watermarkFrom: isoTimestamp(),
    watermarkTo: isoTimestamp(),
    // rowsHeader = สินทรัพย์ที่ sync แตะรอบนี้ (SAP_LEGACY เต็มแถว + PO_FLOW เฉพาะสามคอลัมน์)
    // rowsLine   = ที่สร้างใหม่รอบนี้
    // (entity นี้ไม่มีโครง header-line ให้นับ ใช้ช่องเดิมเล่าเรื่องที่มีความหมายแทน
    //  ดีกว่าเพิ่มคอลัมน์ที่อีกสอง entity ปล่อยว่างตลอดกาล)
    rowsHeader: integer().default(0).notNull(),
    rowsLine: integer().default(0).notNull(),
    // แถวที่ไม่ได้แตะเลย = เลขนั้นเคยมีแต่ถูก soft delete ไปแล้ว (เคารพการลบ ไม่ปลุกคืน)
    // ⚠️ ก่อนหน้านี้ตัวเลขนี้รวมแถว PO_FLOW ที่ข้ามทั้งแถวด้วย — ตั้งแต่ connector เติม
    //    assetClass/categoryId/uom ให้ PO_FLOW แล้ว แถวพวกนั้นย้ายไปนับใน rowsHeader
    //    ค่าในแถวเก่าของตารางนี้จึงเทียบกับแถวใหม่ตรง ๆ ไม่ได้
    rowsSkipped: integer().default(0).notNull(),
    sapMs: integer(),
    txMs: integer(),
    status: enumSyncStatus().notNull(),
    error: text(),
  },
  (table) => [
    index('idx_sap_asset_sync_event_started_at').on(table.startedAt),
    index('idx_sap_asset_sync_event_status').on(table.status),
  ],
);

// ───────────────────────────────────────────────────────────────────────────
// เลขสินทรัพย์ที่ AMS ถืออยู่ แต่ SAP ไม่รู้จัก
//
// ทางเดินปกติคือ บัญชีพิมพ์เลขให้ชิ้นนั้นใน AMS (assignAssetNumber) แล้วรอบ sync ถัดไป
// เอาเลขนั้นไปหาใน OITM เพื่อดึงหมวด/หน่วยนับ/AssetClass (และมูลค่าทางบัญชีในอนาคต) กลับมา
//
// ทำไมต้องมีตาราง ไม่ใช่แค่ตัวนับ: "หาไม่เจอ" คืออาการของปัญหาจริงที่ต้องมีคนไปทำอะไรสักอย่าง
// — พิมพ์เลขผิด หรือของชิ้นนั้นยังไม่ถูกลงทะเบียนใน SAP จริง ๆ ถ้าเก็บแค่จำนวนก็รู้ว่ามีปัญหา
// แต่ไม่มีทางบอกบัญชีได้ว่าใบไหนชิ้นไหน แล้วสุดท้ายก็ไม่มีใครตามแก้ (เหตุผลเดียวกับ
// sap_grpo_unlinked ข้างล่าง — แพทเทิร์นเดียวกันทั้งหมด)
//
// เป็นภาพ "ปัจจุบัน" ไม่ใช่ประวัติ: รอบไหนหาเจอแล้วให้ลบแถวทิ้ง แถวที่ยังอยู่แปลว่า
// "ณ รอบล่าสุด SAP ยังไม่รู้จักเลขนี้"
//
// ⚠️ ไม่มีแถวในตารางนี้ ≠ ทุกอย่างเรียบร้อย — ชิ้นที่ยังไม่มีเลขสินทรัพย์เลยจะไม่ถูกนับ
//    ตรงนี้ (ไม่มีเลขก็ไม่มีอะไรให้หา) นั่นเป็นคนละสถานะ ดูจาก asset.assetNumber IS NULL
// ───────────────────────────────────────────────────────────────────────────
export const sapAssetUnknownNumber = pgTable(
  'sap_asset_unknown_number',
  {
    // grain = สินทรัพย์หนึ่งชิ้น ไม่ใช่หนึ่งเลข — เลขห้ามซ้ำอยู่แล้ว (uq_asset_number)
    // แต่ผูกด้วย id ทำให้ลบชิ้นทิ้งแล้วแถวนี้หายตามเองผ่าน FK ไม่ค้างเป็นขยะ
    assetId: integer().primaryKey().notNull(),
    // ก๊อปเลขมาเก็บด้วย ไม่ได้ join เอาตอนอ่าน — บัญชีต้องเห็นเลขที่ "เคยพิมพ์ไว้" ตรงนี้
    // แม้ภายหลังจะมีคนไปแก้เลขในชิ้นนั้นแล้ว (แถวจะถูกลบรอบถัดไปถ้าเลขใหม่หาเจอ)
    assetNumber: varchar({ length: 50 }).notNull(),
    // ใบ PO ของชิ้นนั้น — ทางเข้าที่บัญชีใช้ไล่ย้อนว่าของชิ้นนี้มาจากการซื้อครั้งไหน
    poNumber: varchar({ length: 50 }),
    // เห็นครั้งแรกเมื่อไหร่ / ยังหาไม่เจออยู่ล่าสุดเมื่อไหร่ — ค้างนานแค่ไหนคือสิ่งที่บอกว่า
    // เรื่องนี้ถูกลืมหรือยัง (firstSeenAt ห้ามถูกเขียนทับตอน upsert รอบถัดไป)
    firstSeenAt: isoTimestamp().default(sql`now()`).notNull(),
    lastSeenAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.assetId],
      foreignColumns: [asset.id],
      name: 'fk_sap_asset_unknown_number_asset',
    }).onDelete('cascade'),
    index('idx_sap_asset_unknown_number_first_seen').on(table.firstSeenAt),
  ],
);

// ───────────────────────────────────────────────────────────────────────────
// GRPO ที่เชื่อมกลับไปหาบรรทัด PO ไม่ได้
//
// ทำไมต้องมีตาราง ไม่ใช่แค่ตัวนับ: ทุกแถวในนี้คือ "ของที่รับเข้าบริษัทมาแล้วแต่ AMS
// ไม่รู้จัก" โดยเฉพาะ NOT_FROM_PO ซึ่งอาจเป็นสินทรัพย์จริงที่เข้ามาโดยไม่ผ่านจัดซื้อ
// ถ้าเก็บแค่จำนวนก็รู้ว่ามีของหลุด แต่ไม่มีทางตามหาว่าใบไหน
//
// grain = บรรทัด GRPO ฝั่ง SAP (DocEntry + LineNum) ซึ่งเป็นคีย์จริงของ SAP
// ไม่ใช่ DocNum เพราะ DocNum ซ้ำข้าม numbering series ได้
//
// ไม่มี FK สักตัวโดยตั้งใจ — ทั้งตารางคือของที่ผูกกับอะไรไม่ได้ ใส่ FK ก็ขัดกับเหตุผล
// ที่มันมีอยู่ และจะทำให้ insert ไม่ผ่านด้วยเหตุผลเดียวกับที่มันมาอยู่ตรงนี้แต่แรก
//
// เป็นภาพ "ปัจจุบัน" ไม่ใช่ประวัติ: รอบไหนเชื่อมได้แล้วให้ลบแถวทิ้ง (เช่นมีคนไปแก้
// กลุ่มสินค้าใน SAP ให้เข้าเกณฑ์) แถวที่ยังอยู่จึงแปลว่า "ตอนนี้ยังเชื่อมไม่ได้"
// ───────────────────────────────────────────────────────────────────────────
export const enumGrpoUnlinkReason = pgEnum('grpo_unlink_reason', [
  // PDN1.BaseType ≠ 22 — ไม่ได้ก๊อปมาจาก PO เลย (รับของแถม/ตัวอย่าง/รับตรง)
  'NOT_FROM_PO',
  // BaseEntry ชี้ไปใบที่ไม่มีใน OPOR แล้ว
  'BASE_PO_MISSING',
  // PO ใบนั้นมีอยู่ แต่บรรทัดที่อ้างถึงมี item อยู่นอก SAP_ITEM_GROUPS จึงไม่เคยถูก sync
  'PO_LINE_OUT_OF_SCOPE',
]);

export const sapGrpoUnlinked = pgTable(
  'sap_grpo_unlinked',
  {
    // บริษัทเจ้าของใบ (0021) — **ต้องอยู่ในคีย์** เพราะ DocEntry เป็นเลขภายในของแต่ละฐาน
    // UBA กับ UBP เดินเลขของตัวเองอิสระกัน ไม่มี companyCode แล้วแถวของ UBP จะทับ UBA
    companyCode: varchar({ length: 20 }).notNull(),
    grpoDocEntry: integer().notNull(),
    // LineNum ของ SAP เป็น 0-based และเก็บตามนั้น (หลักเดียวกับ purchase_order_item.poLine)
    grpoLineNum: integer().notNull(),
    // เลขที่คนเห็น — ไว้ให้ Finance เอาไปเปิดหาใน SAP ได้โดยไม่ต้องรู้จัก DocEntry
    grpoNo: varchar({ length: 50 }).notNull(),
    grpoDate: date(),
    itemCode: varchar({ length: 50 }),
    itemDescription: varchar(),
    receivedQty: numeric({ mode: 'number' }).notNull(),
    // ว่างเมื่อ NOT_FROM_PO — ไม่มี PO ให้อ้างตั้งแต่ต้น
    basePoNumber: varchar({ length: 50 }),
    baseLine: integer(),
    reason: enumGrpoUnlinkReason().notNull(),
    // UpdateDate ฝั่ง SAP — ใช้ดูว่าเอกสารถูกแก้ล่าสุดเมื่อไหร่ คนละตัวกับ lastSeenAt
    sapUpdateDate: isoTimestamp(),
    // เห็นครั้งแรกเมื่อไหร่ / ยังเห็นอยู่ล่าสุดเมื่อไหร่ — แถวที่ lastSeenAt ค้างเก่ามาก
    // แปลว่าเอกสารหลุดออกจากหน้าต่างที่ sync กวาดไปแล้ว ไม่ใช่ว่าเพิ่งหาย
    firstSeenAt: isoTimestamp().default(sql`now()`).notNull(),
    lastSeenAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.companyCode, table.grpoDocEntry, table.grpoLineNum],
      name: 'pk_sap_grpo_unlinked',
    }),
    foreignKey({
      columns: [table.companyCode],
      foreignColumns: [company.code],
      name: 'fk_sap_grpo_unlinked_company',
    }),
    // ทางเข้าหลัก: "ตอนนี้มีของหลุดเพราะเหตุไหนกี่ใบ"
    index('idx_sap_grpo_unlinked_reason').on(table.reason),
    index('idx_sap_grpo_unlinked_grpo_no').on(table.grpoNo),
  ],
);
