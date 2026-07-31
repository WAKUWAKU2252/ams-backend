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
import { purchaseOrder, purchaseOrderItem } from './purchase';
import { attachment } from './attachment';
import { grpo, grpoLine } from './grpo';
import { assetRequest } from './asset-request';
import { assetRequestOpener } from './asset-request-opener';
import { assetRequestLine } from './asset-request-line';
import { category, uom, department, assetLocation, assetSubLocation, employee } from './master';
import { role, user } from './user';
import { asset } from './asset';

export const purchaseOrderRelations = relations(purchaseOrder, ({ many }) => ({
  items: many(purchaseOrderItem),
  assetRequests: many(assetRequest),
}));

export const purchaseOrderItemRelations = relations(purchaseOrderItem, ({ one, many }) => ({
  purchaseOrder: one(purchaseOrder, {
    fields: [purchaseOrderItem.poNumber],
    references: [purchaseOrder.poNumber],
  }),
  grpoLines: many(grpoLine),
}));

export const grpoRelations = relations(grpo, ({ one, many }) => ({
  lines: many(grpoLine),
  invoice: one(attachment, {
    fields: [grpo.invoiceId],
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
  uom: one(uom, {
    fields: [asset.uomId],
    references: [uom.id],
  }),
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
