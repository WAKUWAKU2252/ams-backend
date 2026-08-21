// สัญญาชนิดข้อมูลของ sync engine — แยกออกจาก sync.engine.ts ที่เหลือไว้เฉพาะ logic
//
// connector ทุกตัว import แต่ชนิดจากไฟล์นี้ ไม่ต้องดึงทั้ง engine เข้ามา
// (engine import connector ผ่าน bindSync ด้วย — แยกชนิดออกมาตัดวงนั้นให้ชัดขึ้น)
import type { db } from '@intrastucture/db';

export type SyncTrigger = 'BUTTON' | 'SCHEDULED';
export type SyncMode = 'BACKFILL' | 'INCREMENTAL';

/** ทรานแซกชันของ drizzle — connector รับไปใช้ต่อ ห้ามเปิดทรานแซกชันของตัวเอง */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** หน้าต่างเวลาแบบครึ่งเปิด [from, to) — null = ไม่จำกัดด้านนั้น */
export interface SyncWindow {
  from: string | null;
  to: string | null;
}

export interface SyncState {
  lastUpdateDate: string | null;
  backfillCursor: string | null;
  backfillFloor: string | null;
  mode: SyncMode;
  /** เวลาที่รอบล่าสุด "จบ" ทั้งทางสำเร็จและทางพัง — ใช้เป็นฐานของ cooldown */
  lastRunAt: string | null;
  /** ใช้เป็น version token กันสองรอบเขียนทับกัน (ดู runSync) */
  updatedAt: string | null;
}

export interface PullResult {
  rowsHeader: number;
  rowsLine: number;
  rowsSkipped: number;
  /** UpdateDate สูงสุดที่เจอ — null ถ้าไม่มีแถวเลย */
  maxUpdateDate: string | null;
}

export type SyncStatus = 'SUCCESS' | 'FAILED';

/** patch ที่เขียนกลับลงตาราง sap_*_sync เมื่อจบรอบ */
export type SyncStatePatch = Partial<SyncState> & {
  lastStatus: SyncStatus;
  lastError: string | null;
};

export interface OpenEventRow {
  trigger: SyncTrigger;
  triggeredBy: number | null;
  mode: SyncMode;
}

export type CloseEventRow = PullResult & {
  status: SyncStatus;
  error: string | null;
  watermarkFrom: string | null;
  watermarkTo: string | null;
  /** เวลาที่ใช้คุยกับ SAP (นอกทรานแซกชัน) */
  sapMs: number;
  /** เวลาที่ทรานแซกชันเปิดค้างจับ ams_db ไว้ — ตัวที่ต้องเฝ้า */
  txMs: number;
};

export interface FailureRow {
  trigger: SyncTrigger;
  triggeredBy: number | null;
  mode: SyncMode;
  error: string;
  /** พังตอนคุยกับ SAP = เวลาจนถึงตอนพัง / พังตอนเขียน = เวลาที่ fetch ใช้จริง */
  sapMs: number;
}

/**
 * สิ่งที่ connector ต้องมี — engine ไม่รู้จักตาราง SAP หรือตารางปลายทางเลย
 * รู้แค่ว่าเรียกอะไรได้บ้าง
 *
 * แยก fetch (คุยกับ SAP) ออกจาก apply (เขียน ams_db) โดยตั้งใจ — engine เรียก fetch
 * นอกทรานแซกชัน แล้วเรียก apply ข้างใน ดูเหตุผลที่หัว sync.engine.ts
 *
 * @typeParam B ก้อนข้อมูลดิบที่ fetch ส่งต่อให้ apply — เป็นเรื่องภายในของ connector
 */
export interface SyncConnector<B = unknown> {
  /** ชื่อที่โผล่ใน log/API เช่น 'purchase_order' */
  entity: string;
  /** กุญแจ advisory lock — ต้องไม่ซ้ำกับ entity อื่น */
  lockKey: number;

  /** จุดต่ำสุดของประวัติฝั่ง SAP — ถามครั้งเดียวตอนรอบแรกเพื่อรู้ว่าถอยถึงไหนแล้วจบ */
  fetchFloor(): Promise<string | null>;
  /** ดึงจาก SAP (+ ค้นข้อมูลอ้างอิงแบบอ่านอย่างเดียว) — ห้ามเขียน ams_db ที่นี่ */
  fetch(windows: SyncWindow[]): Promise<B>;
  /** เขียนลง ams_db — ห้ามคุยกับ SAP ที่นี่ (จะทำให้ทรานแซกชันค้างรอเครื่องอื่น) */
  apply(tx: Tx, batch: B): Promise<PullResult>;

  readState(tx: Tx): Promise<SyncState>;
  readStateOutsideTx(): Promise<SyncState>;
  writeState(tx: Tx, patch: SyncStatePatch): Promise<void>;
  openEvent(tx: Tx, row: OpenEventRow): Promise<number>;
  closeEvent(tx: Tx, id: number, row: CloseEventRow): Promise<void>;
  /** บันทึกรอบที่พัง — ต้องเขียนนอกทรานแซกชันหลักที่ถูก rollback ไปแล้ว */
  logFailure(row: FailureRow): Promise<void>;
}

export type SyncOutcome =
  | { status: 'SKIPPED'; reason: string }
  | ({ status: 'SUCCESS' } & PullResult & { mode: SyncMode; backfillCursor: string | null });
