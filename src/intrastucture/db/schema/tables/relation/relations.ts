// ═══════════════════════════════════════════════════════════════════════════
// relations ทั้งหมดรวมไว้ที่นี่ที่เดียว — ตั้งใจไม่แยกไปอยู่กับตาราง
//
// เหตุผล: ความสัมพันธ์เป็นวงเสมอ (grpoLine.assets ต้องรู้จัก asset / asset.grpoLine
// ต้องรู้จัก grpoLine) ถ้าประกาศ relations ไว้ในไฟล์ตาราง กราฟ import จะวนกันทันที
// แล้ว ESM จะ evaluate ได้ค่า undefined แบบสุ่มตามลำดับโหลด — บั๊กที่หาสาเหตุยากมาก
// แยกออกมาแล้วกราฟเป็นทางเดียวสะอาด: relations.ts -> ไฟล์ตาราง -> _shared.ts
//
// key ของแต่ละ relation คือชื่อที่ใช้ใน db.query(...).with — เปลี่ยนชื่อ = response
// ของ API เปลี่ยนตาม (เช่น items / grpoLines ที่ frontend อ่านอยู่)
// ═══════════════════════════════════════════════════════════════════════════
import { relations } from 'drizzle-orm';
import { purchaseOrder, purchaseOrderItem } from '@intrastucture/db/schema/tables/business/purchase';
import { attachment } from '@intrastucture/db/schema/tables/business/attachment';
import { grpo, grpoLine, grpoInvoice } from '@intrastucture/db/schema/tables/business/grpo';
import { assetRequest } from '@intrastucture/db/schema/tables/business/asset-request';
import { assetRequestOpener } from '@intrastucture/db/schema/tables/business/asset-request-opener';
import { assetRequestLine } from '@intrastucture/db/schema/tables/business/asset-request-line';
import { category, department, assetLocation, assetSubLocation, employee } from '@intrastucture/db/schema/tables/business/master';
import { role, user } from '@intrastucture/db/schema/user';
import { asset } from '@intrastucture/db/schema/tables/business/asset';

export const purchaseOrderRelations = relations(purchaseOrder, ({ one, many }) => ({
  items: many(purchaseOrderItem),
  assetRequests: many(assetRequest),
  // ผู้ขอซื้อ (พนักงาน) — ใช้ resolve แผนก/หัวหน้าเพื่อ route คำขออนุมัติ
  requester: one(employee, {
    fields: [purchaseOrder.ownerPrId],
    references: [employee.id],
  }),
}));

export const purchaseOrderItemRelations = relations(purchaseOrderItem, ({ one, many }) => ({
  purchaseOrder: one(purchaseOrder, {
    fields: [purchaseOrderItem.poNumber],
    references: [purchaseOrder.poNumber],
  }),
  grpoLines: many(grpoLine),
}));

export const grpoRelations = relations(grpo, ({ many }) => ({
  lines: many(grpoLine),
  // invoice ของรอบ — many-to-many ผ่าน grpo_invoice (1 รอบหลายใบ / 1 ใบหลายรอบ)
  invoices: many(grpoInvoice),
}));

export const grpoInvoiceRelations = relations(grpoInvoice, ({ one }) => ({
  grpo: one(grpo, {
    fields: [grpoInvoice.grpoId],
    references: [grpo.id],
  }),
  attachment: one(attachment, {
    fields: [grpoInvoice.attachmentId],
    references: [attachment.id],
  }),
}));

export const grpoLineRelations = relations(grpoLine, ({ one, many }) => ({
  grpo: one(grpo, {
    fields: [grpoLine.grpoId],
    references: [grpo.id],
  }),
  poItem: one(purchaseOrderItem, {
    fields: [grpoLine.poItemId],
    references: [purchaseOrderItem.id],
  }),
  assets: many(asset),
  // จำนวนชิ้นที่คนแจ้งไว้สำหรับรอบนี้ (คำขอละไม่เกินหนึ่งแถว)
  declaredLines: many(assetRequestLine),
}));

export const assetRequestRelations = relations(assetRequest, ({ one, many }) => ({
  purchaseOrder: one(purchaseOrder, {
    fields: [assetRequest.poNumber],
    references: [purchaseOrder.poNumber],
  }),
  assets: many(asset),
  openers: many(assetRequestOpener),
  // จำนวนที่แจ้งเองรายรอบรับของ — มีเฉพาะรอบที่ตัวเลข SAP ใช้ไม่ได้
  lines: many(assetRequestLine),
  createdByUser: one(user, {
    fields: [assetRequest.createdBy],
    references: [user.id],
  }),
  // manager ที่คำขอนี้ถูก route ไปหา (หัวหน้าแผนกของผู้เปิด PO) — snapshot ตอน submit
  assignedManager: one(user, {
    fields: [assetRequest.assignedManagerId],
    references: [user.id],
  }),
}));

export const assetRequestOpenerRelations = relations(assetRequestOpener, ({ one }) => ({
  request: one(assetRequest, {
    fields: [assetRequestOpener.requestId],
    references: [assetRequest.id],
  }),
  user: one(user, {
    fields: [assetRequestOpener.userId],
    references: [user.id],
  }),
}));

export const assetRequestLineRelations = relations(assetRequestLine, ({ one }) => ({
  request: one(assetRequest, {
    fields: [assetRequestLine.requestId],
    references: [assetRequest.id],
  }),
  grpoLine: one(grpoLine, {
    fields: [assetRequestLine.grpoLineId],
    references: [grpoLine.id],
  }),
  createdByUser: one(user, {
    fields: [assetRequestLine.createdBy],
    references: [user.id],
  }),
  updatedByUser: one(user, {
    fields: [assetRequestLine.updatedBy],
    references: [user.id],
  }),
}));

export const departmentRelations = relations(department, ({ many }) => ({
  employees: many(employee),
}));

export const employeeRelations = relations(employee, ({ one }) => ({
  department: one(department, {
    fields: [employee.departmentId],
    references: [department.id],
  }),
}));

export const roleRelations = relations(role, ({ many }) => ({
  users: many(user),
}));

// อีเมลไม่อยู่ที่นี่แล้ว — ไต่ผ่าน employee เอา (with: { employee: true } แล้วอ่าน .email)
export const userRelations = relations(user, ({ one }) => ({
  role: one(role, {
    fields: [user.roleId],
    references: [role.id],
  }),
  employee: one(employee, {
    fields: [user.employeeId],
    references: [employee.id],
  }),
}));

export const assetLocationRelations = relations(assetLocation, ({ many }) => ({
  subLocations: many(assetSubLocation),
}));

export const assetSubLocationRelations = relations(assetSubLocation, ({ one }) => ({
  location: one(assetLocation, {
    fields: [assetSubLocation.locationId],
    references: [assetLocation.id],
  }),
}));

export const assetRelations = relations(asset, ({ one }) => ({
  request: one(assetRequest, {
    fields: [asset.requestId],
    references: [assetRequest.id],
  }),
  grpoLine: one(grpoLine, {
    fields: [asset.grpoLineId],
    references: [grpoLine.id],
  }),
  image: one(attachment, {
    fields: [asset.imageId],
    references: [attachment.id],
  }),
  category: one(category, {
    fields: [asset.categoryId],
    references: [category.id],
  }),
  // ไม่มี uom relation แล้ว — asset.uom เป็น varchar ตั้งแต่ 0011 (ดู master.ts)
  location: one(assetLocation, {
    fields: [asset.locationId],
    references: [assetLocation.id],
  }),
  subLocation: one(assetSubLocation, {
    fields: [asset.subLocationId],
    references: [assetSubLocation.id],
  }),
  employee: one(employee, {
    fields: [asset.employeeId],
    references: [employee.id],
  }),
  // แผนกที่สังกัด — คนละแกนกับ employee ข้างบน (ของกลางไม่มีผู้ถือครองแต่มีแผนกได้)
  department: one(department, {
    fields: [asset.departmentId],
    references: [department.id],
  }),
  // สาม relation ชี้ user คนละคอลัมน์ — ใช้โชว์ชื่อผู้ทำรายการโดยไม่ต้อง join เอง
  createdByUser: one(user, {
    fields: [asset.createdBy],
    references: [user.id],
  }),
  updatedByUser: one(user, {
    fields: [asset.updatedBy],
    references: [user.id],
  }),
  deletedByUser: one(user, {
    fields: [asset.deletedBy],
    references: [user.id],
  }),
}));
