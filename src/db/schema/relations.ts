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
import { category, uom, department, assetLocation, assetSubLocation, employee } from './master';
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
}));

export const assetRequestRelations = relations(assetRequest, ({ one, many }) => ({
  purchaseOrder: one(purchaseOrder, {
    fields: [assetRequest.poNumber],
    references: [purchaseOrder.poNumber],
  }),
  assets: many(asset),
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
}));
