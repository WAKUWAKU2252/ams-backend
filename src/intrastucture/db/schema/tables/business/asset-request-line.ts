// ═══════════════════════════════════════════════════════════════════════════
// asset_request_line — "รอบรับของรอบนี้ จะขึ้นทะเบียนเป็นสินทรัพย์กี่ชิ้น"
//
// ปกติจำนวนชิ้นที่ลงได้ = grpo_line.receivedQty (ตัวเลขจาก SAP) ซึ่งใช้ได้ตราบใดที่
// หน่วยนับของ PO เป็น "ชิ้น" — แต่ PO งานเหมา (เช่น "งานติดตั้งระบบ CCTV" qty 1)
// รับมา 1 "งาน" ที่ข้างในเป็นกล้อง 11 + NVR 1 หน่วยจึงไม่ตรงกับจำนวนชิ้นเลย
// เอา receivedQty มาเป็นเพดานตรง ๆ = เทียบคนละหน่วย ไม่ใช่แค่เข้มเกินไป
//
// แถวนี้คือการที่ "คน" ประกาศจำนวนชิ้นของรอบนั้นแทนตัวเลข SAP — จึงต้อง store
// (derive ไม่ได้ ตามหลักเดียวกับ asset_request.status ที่เกิดจากการกดของมนุษย์)
// พร้อม reason ที่บังคับกรอกเสมอ เพราะทุกแถวคือการเบี่ยงจากเอกสาร ต้องมีคนรับผิดชอบ
//
// grain = (คำขอ × รอบรับของ) ตรงกับ receivedQty พอดี กติกาทั้งระบบจึงเหลือประโยคเดียว:
//   จำนวนช่องของรอบ = declaredQty ถ้ามีแถวนี้ / ไม่มีก็ receivedQty ตาม SAP
// (ไม่มีแถว = บรรทัดปกติ ไม่ต้องสร้างแถว default ให้บวม)
// ═══════════════════════════════════════════════════════════════════════════
import { pgTable, integer, uuid, varchar, foreignKey, primaryKey, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from '@intrastucture/db/schema/shared/iso-timestamp';
import { assetRequest } from './asset-request';
import { grpoLine } from './grpo';
import { user } from '@intrastucture/db/schema/user';

export const assetRequestLine = pgTable(
  'asset_request_line',
  {
    requestId: integer().notNull(),
    grpoLineId: uuid().notNull(),
    declaredQty: integer().notNull(),
    // บังคับเสมอ — ไม่ใช่ nullable เพราะการมีแถวนี้แปลว่าตัวเลขไม่ตรงกับ SAP แล้ว
    // manager ต้องอ่านเหตุผลก่อนอนุมัติ ปล่อยว่างได้เมื่อไรก็เท่ากับไม่มีการควบคุม
    reason: varchar({ length: 500 }).notNull(),
    createdBy: integer().notNull(),
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    updatedBy: integer().notNull(),
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    // 1 รอบต่อ 1 คำขอ มีได้แถวเดียว — แจ้งซ้ำ = แก้ของเดิม ไม่ใช่เพิ่มแถวแล้วบวกกัน
    primaryKey({ columns: [table.requestId, table.grpoLineId], name: 'pk_asset_request_line' }),
    // ไม่ cascade ทั้งคู่: แถวนี้เป็นหลักฐานประกอบการอนุมัติ ห้ามหายเงียบตามใบ/ตามรอบที่ถูกลบ
    // (ผลข้างเคียงที่ตั้งใจ: SAP sync ที่พยายามลบรอบซึ่งมีคนแจ้งไว้แล้วจะถูก DB ปฏิเสธ)
    foreignKey({
      columns: [table.requestId],
      foreignColumns: [assetRequest.id],
      name: 'fk_asset_request_line_request',
    }),
    foreignKey({
      columns: [table.grpoLineId],
      foreignColumns: [grpoLine.id],
      name: 'fk_asset_request_line_grpo_line',
    }),
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_line_created_by',
    }),
    foreignKey({
      columns: [table.updatedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_line_updated_by',
    }),
    // pg สร้าง index ให้เฉพาะคอลัมน์แรกของ PK (requestId) — ฝั่ง grpoLineId ต้องเพิ่มเอง
    // เพราะตอนเรนเดอร์ฟอร์มต้องถามว่า "รอบนี้ถูกแจ้งไว้หรือยัง" ทีละรอบ
    index('idx_asset_request_line_grpo_line_id').on(table.grpoLineId),
    index('idx_asset_request_line_created_by').on(table.createdBy),
    index('idx_asset_request_line_updated_by').on(table.updatedBy),
    // 0 = ประกาศว่ารอบนี้ไม่เกิดสินทรัพย์ (เช่น ค่าบริการรายงวด) ติดลบไม่มีความหมาย
    check('ck_asset_request_line_declared_qty', sql`${table.declaredQty} >= 0`),
  ],
);
