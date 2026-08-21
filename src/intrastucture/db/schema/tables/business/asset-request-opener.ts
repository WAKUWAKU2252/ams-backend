// ═══════════════════════════════════════════════════════════════════════════
// asset_request_opener — ใครเคยเปิด draft ใบไหนไปแล้วบ้าง (many-to-many)
//
// draft 1 ใบ shared ทั้งระบบ (ใครก็เปิดต่อได้) แต่หน้า draft list ของแต่ละคน
// ต้องเห็นเฉพาะ "ใบที่ตัวเองเคยเปิด" — เก็บใน 1 คอลัมน์ไม่ได้ จึงต้องตารางกลางนี้
// upsert 1 แถวตอน GET /asset-requests/:id (คนเดิมเปิดซ้ำ = อัปเดต lastOpenedAt ไม่เพิ่มแถว)
// ═══════════════════════════════════════════════════════════════════════════
import { pgTable, integer, foreignKey, primaryKey, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from '@intrastucture/db/schema/shared/iso-timestamp';
import { assetRequest } from './asset-request';
import { user } from '@intrastucture/db/schema/user';

export const assetRequestOpener = pgTable(
  'asset_request_opener',
  {
    requestId: integer().notNull(),
    userId: integer().notNull(),
    firstOpenedAt: isoTimestamp().default(sql`now()`).notNull(),
    lastOpenedAt: isoTimestamp().default(sql`now()`).notNull(),
  },
  (table) => [
    // 1 คู่ (ใบ × คน) มีได้แถวเดียว — กันเปิดซ้ำแล้วบวมเป็นหลายแถว
    primaryKey({ columns: [table.requestId, table.userId], name: 'pk_asset_request_opener' }),
    foreignKey({
      columns: [table.requestId],
      foreignColumns: [assetRequest.id],
      name: 'fk_asset_request_opener_request',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'fk_asset_request_opener_user',
    }),
    // pg สร้าง index ให้เฉพาะคอลัมน์แรกของ PK (requestId) — ต้องเพิ่มฝั่ง userId เอง
    // เพราะ query หลักคือ "draft ที่ user คนนี้เคยเปิด" (WHERE userId = ?)
    index('idx_asset_request_opener_user_id').on(table.userId),
  ],
);
