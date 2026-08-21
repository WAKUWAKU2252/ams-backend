// ใบคำขอลงทะเบียน — draft 1 ใบครอบ PO ทั้งใบ (design A)
// ราย line/รายชิ้นอยู่ที่ asset.grpoLineId ไม่เก็บซ้ำที่นี่
//
// หลักคิดของ draft: DRAFT = "ยังไม่เสร็จ" DB จึงต้องหลวม (ยอม NULL เกือบทั้งแผง)
// แล้วความเข้มทั้งหมดไปอยู่ที่ด่าน submit ใน service — เข้มผิดชั้น ระบบใช้ไม่ได้
import { pgTable, pgEnum, serial, varchar, integer, foreignKey, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { isoTimestamp } from '@intrastucture/db/schema/shared/iso-timestamp';
import { purchaseOrder } from './purchase';
import { user } from '@intrastucture/db/schema/user';

// สถานะพวกนี้เกิดจากการตัดสินใจของมนุษย์ (กดส่ง/กดอนุมัติ) derive ไม่ได้จึงต้อง store
// ต่างจากสถานะของ PO line ที่เป็นเลขคณิต (สั่ง−รับ−ลงแล้ว) ซึ่งห้าม store
//
// ── ใบตอบคำถามเดียว: "หัวหน้าอนุมัติจำนวนชิ้นของรอบนี้แล้วหรือยัง" — จบที่ APPROVED (0014)
//
// REGISTERED/CANCELLED ถูกถอดออกเพราะเป็นเรื่องของ "ชิ้น" ไม่ใช่ของ "ใบ":
// บัญชีลงเลข/ตัดทิ้งทีละชิ้น ใบเดียวจึงมีชิ้นที่ลงแล้วกับชิ้นที่ยังไม่ลงพร้อมกันได้เสมอ
// การยัดสองค่านั้นไว้ที่ใบทำให้ต้องเลือกว่าจะให้ใบเป็นค่าไหน ซึ่งตอบไม่ได้จริง
//
// สามคำถาม สามที่ อย่าเอามาปนกันอีก:
//   ใบ   asset_request.status        หัวหน้าอนุมัติหรือยัง
//   ชิ้น  asset.lifecycle             ชิ้นนี้ไปถึงไหนแล้ว
//   PO   purchase_order.docStatus    ยังมีของจะมาอีกไหม (SAP เป็นคนบอก)
export const enumRequestStatus = pgEnum('request_status', [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
]);

export const assetRequest = pgTable(
  'asset_request',
  {
    id: serial().primaryKey().notNull(),
    poNumber: varchar({ length: 50 }).notNull(),

    // ไม่มี default+notNull = insert แล้วได้ NULL ไม่ใช่ DRAFT → กลไกกันใบซ้ำเป็นอัมพาต
    status: enumRequestStatus().default('DRAFT').notNull(),
    submittedAt: isoTimestamp(),
    // FK -> user.id: คนกดส่ง (RequestBy) — คนละคนกับ createdBy ได้ เพราะใบเป็นของกลางต่อ PO
    // ใครเปิดคนแรกกับใครกดส่งจึงไม่จำเป็นต้องเป็นคนเดียวกัน และผู้อนุมัติต้องตามถามคนกดส่ง
    // nullable: ใบที่ส่งไปแล้วก่อน 0009 ไม่มีข้อมูลนี้ เดาย้อนหลังไม่ได้
    submittedBy: integer(),

    // ── สถานะการแจ้งเตือนเข้า Teams (เพิ่มใน 0009)
    //
    // ก่อนหน้านี้ไม่มีที่ไหนบันทึกเลยว่าใบนี้แจ้งเตือนสำเร็จหรือยัง ผลคือแจ้งเตือนล้ม
    // แล้วใบค้าง PENDING_APPROVAL เงียบ ๆ ส่งซ้ำก็ไม่ได้ (สถานะไม่ใช่ DRAFT/REJECTED แล้ว)
    // และหาไม่เจอด้วยว่ามีใบไหนตกค้างบ้าง ต้องไล่ถามทีละใบ
    //
    // notifiedAt = NULL แต่ status = PENDING_APPROVAL คือ "ส่งแล้วแต่ยังไม่มีใครรู้"
    // ซึ่งเป็นคิวรีเดียวที่ตอบได้ว่าต้องตามเก็บใบไหน
    notifiedAt: isoTimestamp(),
    // ข้อความล้มครั้งล่าสุด — ไว้บอกว่าต้องไปแก้อะไรก่อนกดส่งซ้ำ (เช่นหัวหน้าไม่มีอีเมล)
    // ทับทุกครั้งที่ลองใหม่ ไม่เก็บประวัติ: ต้องการแค่ "ตอนนี้ติดอะไร" ไม่ใช่ log
    notifyError: varchar({ length: 500 }),
    // FK -> user.id: manager ที่กด approve/reject (audit) — เดิม varchar, ย้ายเป็น FK
    approvedBy: integer(),
    approvedAt: isoTimestamp(),
    rejectedBy: integer(),
    rejectedAt: isoTimestamp(),
    rejectReason: varchar({ length: 500 }),
    // role ของคนที่ตีกลับ ณ ตอนกด (0016) — APPROVER_ROLES มีทั้ง MANAGER/FINANCE/ADMIN
    // การตีกลับทั้งใบจึงไม่ได้แปลว่ามาจากหัวหน้าเสมอไป และผู้ขอต้องรู้ว่าใครตีกลับถึงจะรู้ว่า
    // ต้องไปคุยกับใคร — snapshot ไม่ใช่ join role ปัจจุบัน (เหตุผลเดียวกับ asset.rejectedRole)
    rejectedRole: varchar({ length: 50 }),
    // เวลาที่บัญชีกดยืนยันว่าออกเลขครบแล้ว (ปุ่ม Submit ที่หัวใบ) — ไม่ใช่เวลาที่เลขครบเอง
    // การกดเป็นการตัดสินใจของคน: เลขอาจครบแล้วแต่บัญชียังอยากตรวจอีกรอบก่อนแจ้งผู้ขอ
    completeDate: isoTimestamp(),
    // FK -> user.id: ใครกดยืนยัน — เก็บด้วยเหตุผลเดียวกับ approvedBy/rejectedBy
    // การแจ้งผลออกไปหาผู้ขอเป็นการกระทำที่ต้องมีเจ้าของ ไม่ใช่เหตุการณ์ลอย ๆ ของระบบ
    completedBy: integer(),

    // ── สถานะการแจ้งเตือน "ลงทะเบียนเสร็จแล้ว" กลับไปหาผู้ขอ (0013)
    //
    // คู่ใหม่ ไม่ใช้ notifiedAt/notifyError ข้างบนซ้ำ — สองรอบนี้เป็นคนละเหตุการณ์
    // (แจ้งหัวหน้าตอนส่งอนุมัติ / แจ้งผู้ขอตอนได้เลข) ถ้าใช้คอลัมน์เดียวกัน การแจ้งรอบสอง
    // จะทับร่องรอยของรอบแรก แล้วตอบไม่ได้ว่ารอบไหนล้ม
    //
    // NULL ทั้งที่ status = REGISTERED = "ปิดงานแล้วแต่ผู้ขอยังไม่รู้" ซึ่งเป็นคิวรีเดียว
    // ที่ตอบได้ว่าต้องตามส่งซ้ำใบไหน (เหตุผลเดียวกับ notifiedAt ที่อธิบายไว้ข้างบน)
    completeNotifiedAt: isoTimestamp(),
    completeNotifyError: varchar({ length: 500 }),
    // ── รอบแจ้ง "ยังไม่จบ มีชิ้นต้องแก้" (0017) — ปุ่มเดียวกับข้างบนแต่คนละผลลัพธ์
    //
    // ★ ห้ามใช้ completeNotifiedAt ซ้ำเด็ดขาด: ตัวนั้นเป็นธงปิดงานถาวร ทั้งกรองใบออกจาก
    // คิวบัญชี (listPendingRegistration) และเป็นเส้นตายห้ามแก้อะไรอีก (assign/reject/cancel)
    // ถ้าการแจ้งตีกลับไปเซ็ตมัน ใบจะหลุดจากคิวทั้งที่งานยังไม่จบ แล้วพอผู้ขอแก้เสร็จก็ไม่มี
    // ใครออกเลขให้ได้อีก — ใบตายคาที่โดยไม่มี error ให้เห็น
    //
    // ใช้เทียบกับ asset.updatedAt เพื่อกันกดแจ้งซ้ำทั้งที่ไม่มีอะไรเปลี่ยนตั้งแต่รอบก่อน
    // (ซึ่งเป็นอาการเดียวกับที่ flow นี้ตั้งใจจะเลิก คือผู้ขอได้เมลรัวโดยไม่มีอะไรใหม่)
    rejectNotifiedAt: isoTimestamp(),
    rejectNotifyError: varchar({ length: 500 }),

    // FK -> user.id: ใครเปิดใบนี้คนแรก (audit) — อ่านจาก token เท่านั้น ห้ามรับจาก body
    createdBy: integer().notNull(),

    // FK -> user.id: manager ที่คำขอนี้ถูก route ไปหา (snapshot ตอน submit) = หัวหน้าแผนกของผู้เปิด PO
    // ไว้ audit/escalation และให้ callback ตอนกดอนุมัติเทียบว่าคนกดตรงกับผู้ที่ตั้งใจส่งไปหา; nullable ตอน DRAFT
    assignedManagerId: integer(),

    // lock กันแก้พร้อมกันย้ายไป in-memory (presence registry) แล้ว — ไม่เก็บที่ DB อีก
    createdAt: isoTimestamp().default(sql`now()`).notNull(),
    // ตัวตัดสิน "draft ร้าง" ของ cleanup job อนาคต + optimistic check กัน lost update ตอน save
    updatedAt: isoTimestamp().default(sql`now()`).notNull(),

    deletedAt: isoTimestamp(),
    // FK -> user.id เหมือน approvedBy/rejectedBy/createdBy — เดิมเป็น varchar อยู่คอลัมน์เดียวในตาราง
    deletedBy: integer(),
  },
  (table) => [
    // ไม่ cascade: ใบคำขอเป็นข้อมูลธุรกิจ (soft delete) — ห้ามหายเงียบตาม PO ที่ถูกลบ
    foreignKey({
      columns: [table.poNumber],
      foreignColumns: [purchaseOrder.poNumber],
      name: 'fk_asset_request_po_number',
    }),
    // ลบ user ที่ยังมี draft ค้างอยู่ไม่ได้ (ไม่ cascade — ใบคำขอเป็นข้อมูลธุรกิจ soft delete)
    foreignKey({
      columns: [table.createdBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_created_by',
    }),
    foreignKey({
      columns: [table.approvedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_approved_by',
    }),
    foreignKey({
      columns: [table.rejectedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_rejected_by',
    }),
    foreignKey({
      columns: [table.deletedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_deleted_by',
    }),
    foreignKey({
      columns: [table.assignedManagerId],
      foreignColumns: [user.id],
      name: 'fk_asset_request_assigned_manager',
    }),
    foreignKey({
      columns: [table.submittedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_submitted_by',
    }),
    foreignKey({
      columns: [table.completedBy],
      foreignColumns: [user.id],
      name: 'fk_asset_request_completed_by',
    }),
    // pg ไม่สร้าง index ให้ฝั่ง FK เอง — ใช้ตอน join/เช็ค draft ของ PO
    index('idx_asset_request_po_number').on(table.poNumber),
    index('idx_asset_request_assigned_manager_id').on(table.assignedManagerId),
    index('idx_asset_request_created_by').on(table.createdBy),
    index('idx_asset_request_approved_by').on(table.approvedBy),
    index('idx_asset_request_rejected_by').on(table.rejectedBy),
    index('idx_asset_request_deleted_by').on(table.deletedBy),
    index('idx_asset_request_submitted_by').on(table.submittedBy),
    // กรรมการกันใบซ้ำ: PO หนึ่งใบมี "รอบที่ยังเปิดค้าง" ได้รอบเดียว
    //
    // ⚠️ ตัวนี้ตอบแค่ "ตอนนี้มีรอบที่ยังแก้อยู่บน PO นี้ไหม" ไม่ได้ตอบว่า "PO นี้จบหรือยัง"
    // (คำถามหลังดูที่ purchase_order.docStatus ซึ่ง SAP เป็นคนบอก)
    //
    // เดิมชื่อ uq_asset_request_active และรวม APPROVED ไว้ในล็อกด้วย ซึ่งเป็นบั๊ก: ของ PO
    // เดียวมาหลายรอบ (GRPO ใบต่อใบ) พอรอบแรกอนุมัติแล้วรอบัญชีออกเลข รอบที่สองจะเปิด
    // ใบใหม่ไม่ได้เลยจนกว่าบัญชีจะลงเลขครบ ทั้งที่ของมาถึงแล้ว — คำว่า "active" กำกวม
    // จนพาไปผูกสองความหมายเข้าด้วยกัน ชื่อใหม่จึงบอกตรง ๆ ว่าล็อกอะไร
    //
    // REJECTED ต้องอยู่ในล็อกด้วย: ใบที่ถูกตีกลับยังเป็นรอบที่เปิดค้าง ต้องแก้แล้วส่งใหม่
    // ถ้าปลดล็อกจะมีคนเปิดใบใหม่ทับแล้วทิ้งเหตุผลตีกลับไว้เฉย ๆ (เคยพังมาแล้ว — review #1)
    uniqueIndex('uq_asset_request_open_round')
      .on(table.poNumber)
      .where(
        sql`${table.status} IN ('DRAFT', 'PENDING_APPROVAL', 'REJECTED') AND ${table.deletedAt} IS NULL`,
      ),
  ],
);
