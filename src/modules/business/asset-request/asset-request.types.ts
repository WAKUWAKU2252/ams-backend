// สัญญาชนิดข้อมูลของโมดูล asset-request — ไม่มี logic ไม่ import service
import type { assetRequest, assetRequestLine } from '@intrastucture/db/schema';
import type { listQuery } from './asset-request.schema';

export type AssetRequestRow = typeof assetRequest.$inferSelect;
export type RequestStatus = AssetRequestRow['status'];
export type AssetRequestLineRow = typeof assetRequestLine.$inferSelect;

/** query ของหน้า list — derive จาก schema ตัวเดียวกับที่ Elysia ใช้ validate */
export type ListQuery = typeof listQuery.static;

/**
 * เปิดใบร่าง — reused บอกว่าได้ใบเดิมกลับไป ไม่ใช่ใบใหม่
 * (เปิดซ้ำ PO เดิมที่ยังไม่จบ ต้องได้ใบเดิม ไม่ใช่สร้างใบซ้อน)
 */
export interface CreateDraftResult {
  requestId: number;
  reused: boolean;
}

/** จำนวนที่แจ้งเองต่อรอบรับของ — ใช้เป็นค่าใน map ของ declaredMap() */
export interface DeclaredLine {
  declaredQty: number;
  reason: string;
}

/** รอบรับของ -> จำนวนที่แจ้งไว้ (key = grpoLine.id ซึ่งเป็น uuid) */
export type DeclaredMap = Map<string, DeclaredLine>;

/** ผลของ action ที่เปลี่ยนสถานะใบ (submit/approve/reject/leave) */
export interface RequestActionResult {
  id: number;
  status: RequestStatus;
}
