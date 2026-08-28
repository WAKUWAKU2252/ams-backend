// ═══════════════════════════════════════════════════════════════════════════
// connector ของ Purchase Order — บอก engine ว่าดึงอะไรจาก SAP แล้วลงตารางไหน
// ตัว engine ไม่รู้จัก OPOR/POR1 เลย ความรู้เรื่อง SAP จบอยู่ในไฟล์นี้
//
// fetch = คุยกับ SAP อย่างเดียว / apply = เขียน ams_db อย่างเดียว
// แยกกันเพราะ engine เรียก fetch นอกทรานแซกชัน (ดูเหตุผลที่ sync.engine.ts)
// ═══════════════════════════════════════════════════════════════════════════
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import {
  purchaseOrder,
  purchaseOrderItem,
  employee,
  sapPurchaseOrderSync,
  sapPurchaseOrderSyncEvent,
} from '@intrastucture/db/schema';
import { sapQuery, asDateTime } from '@intrastucture/sap/client';
import { docKey, ownerCodeColumn, lockKeyFor } from '@/modules/integrate/SAP/company.util';
import { poWindow, poByDocEntries, poMinUpdateDate } from '@intrastucture/sap/queries';
import type { SyncConnector, Tx, PullResult, SyncState, SyncWindow } from '@/modules/integrate/SAP/sync.engine';
import { emptyResult } from '@/modules/integrate/SAP/sync.engine';
import { requireRow } from '@common/db-result';
import { toIso, toDateOnly, toNum, toStr, maxIso, chunk, nowIso } from '@/modules/integrate/SAP/sync.util';

export type PoRow = {
  docEntry: number;
  docNum: number;
  /** NNM1.BeginStr ของ series ที่ใบนี้ใช้ เช่น 'APO-' — NULL ได้ (series 'Primary') */
  beginStr: string | null;
  vendorName: string | null;
  docDate: Date | null;
  ownerCode: number | null;
  /** OPOR.DocStatus ดิบจาก SAP — 'O' = Open / 'C' = Closed (แปลงด้วย toDocStatus) */
  docStatus: string | null;
  updateDate: Date | null;
  ownerPrName: string | null;
  lineNum: number;
  itemCode: string | null;
  itemGroup: number | null;
  itemDescription: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
};

/**
 * แปลง OPOR.DocStatus ('O'/'C') เป็นค่า enum ของ ams_db
 *
 * ค่าที่ไม่รู้จักคืน null ไม่ใช่เดาเป็น OPEN — SAP เพิ่มสถานะใหม่ได้ และการเดาจะทำให้
 * ใบที่สถานะจริงเป็นอย่างอื่นถูกนับรวมกับใบที่เปิดอยู่โดยไม่มีอะไรฟ้อง
 * (null ในคอลัมน์นี้แปลว่า "ไม่รู้" อยู่แล้ว ซึ่งตรงกับความจริงมากกว่า)
 */
function toDocStatus(v: string | null): 'OPEN' | 'CLOSED' | null {
  const s = v?.trim().toUpperCase();
  if (s === 'O') return 'OPEN';
  if (s === 'C') return 'CLOSED';
  return null;
}

// ก้อนละ 500 แถว — ต่ำกว่าเพดาน bind parameter ของ pg มาก และยังไม่ถี่จนเปลือง round-trip
const INSERT_CHUNK = 500;
// ค้นด้วย IN (...) ก็กิน parameter เหมือนกัน แต่คอลัมน์เดียวจึงใส่ได้มากกว่า
const LOOKUP_CHUNK = 1000;

/** ดึงหลายหน้าต่างจาก SAP แล้วรวมเป็นชุดเดียว (แถวซ้ำข้ามหน้าต่างไม่เป็นไร — upsert ทับ) */
export async function fetchPoWindows(
  companyCode: string,
  itemGroups: string | null,
  windows: SyncWindow[],
): Promise<PoRow[]> {
  const out: PoRow[] = [];
  for (const w of windows) {
    const rows = await sapQuery<PoRow>(companyCode, poWindow(itemGroups), {
      from: asDateTime(w.from),
      to: asDateTime(w.to),
    });
    out.push(...rows);
  }
  return out;
}

/** ดึง PO แม่เฉพาะใบที่ระบุ — GRPO connector เรียกเมื่อเจอ PO ที่ยังไม่ถูก sync */
export async function fetchPoByDocEntries(
  companyCode: string,
  itemGroups: string | null,
  docEntries: number[],
): Promise<PoRow[]> {
  if (docEntries.length === 0) return [];
  const out: PoRow[] = [];
  // ต่อลง SQL ตรง ๆ (ไม่ใช่ bind parameter) จึงต้องซอยกันคำสั่งยาวเกินไป
  for (const part of chunk(docEntries, LOOKUP_CHUNK)) {
    out.push(...(await sapQuery<PoRow>(companyCode, poByDocEntries(itemGroups, part), {})));
  }
  return out;
}

/**
 * upsert ทั้ง header และ line — export ไว้ให้ connector ของ GRPO เรียกตอนต้องเขียน
 * PO แม่ลงไปก่อนในทรานแซกชันเดียวกัน
 */
export async function applyPoRows(tx: Tx, companyCode: string, rows: PoRow[]): Promise<PullResult> {
  if (rows.length === 0) return emptyResult();

  // header ซ้ำมาตามจำนวนบรรทัด — ยุบก่อน ไม่งั้น upsert ชุดเดียวมี key ซ้ำ pg ปฏิเสธ
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time")
  const headers = new Map<string, PoRow>();
  for (const r of rows) headers.set(docKey(r.beginStr, r.docNum), r);

  // ownerPrId เป็น FK ไป employee.id ซึ่งเป็นเลขเรียงของ AMS เอง ไม่ใช่เลขของ SAP
  // จึงต้องแปลงสองต่อ: OPOR.OwnerCode -> employee.ownerCode -> employee.id
  // (เดิมโค้ดนี้ใส่ OwnerCode ลงคอลัมน์นี้ตรง ๆ เพราะสมัยนั้น employee.id คือ
  //  รหัสจากระบบ HR ซึ่งภายหลังพบว่าเป็นคนละชุดกับ SAP จึงเชื่อมกันไม่ได้เลย
  //  — ห้ามย้อนกลับไปเก็บ OwnerCode ตรง ๆ อีก employee.ownerCode คือจุดเชื่อมเดียว)
  //
  // SAP มีพนักงานครบกว่า AMS เสมอ — รหัสที่หาไม่เจอต้องปล่อย null ไม่งั้น FK พังทั้งรอบ
  // (ownerPrName ยังเก็บได้ตามปกติ ชื่อไม่ใช่ FK จึงไม่หายไปด้วย)
  const ownerCodes = [
    ...new Set([...headers.values()].map((r) => r.ownerCode).filter((v): v is number => v != null)),
  ];
  //
  // ★ ต้องค้นในคอลัมน์ของบริษัทนี้เท่านั้น (0021) — OHEM สองฐานเดินเลขทับกัน 264 ตัว
  //   ค้นผิดคอลัมน์ = ผูก PO เข้ากับพนักงานอีกบริษัทที่บังเอิญเลขตรงกัน
  const ownerCol = ownerCodeColumn(companyCode);
  const empIdByOwnerCode = new Map<number, number>();
  for (const part of chunk(ownerCodes, LOOKUP_CHUNK)) {
    const found = await tx
      .select({ id: employee.id, ownerCode: ownerCol })
      .from(employee)
      .where(inArray(ownerCol, part));
    for (const e of found) if (e.ownerCode != null) empIdByOwnerCode.set(e.ownerCode, e.id);
  }

  for (const part of chunk([...headers.values()], INSERT_CHUNK)) {
    await tx
      .insert(purchaseOrder)
      .values(
        part.map((r) => ({
          poNumber: docKey(r.beginStr, r.docNum),
          companyCode,
          docEntry: r.docEntry,
          vendorName: toStr(r.vendorName),
          poDate: toDateOnly(r.docDate),
          ownerPrName: toStr(r.ownerPrName),
          ownerPrId: r.ownerCode == null ? null : (empIdByOwnerCode.get(r.ownerCode) ?? null),
          docStatus: toDocStatus(r.docStatus),
        })),
      )
      .onConflictDoUpdate({
        target: purchaseOrder.poNumber,
        set: {
          vendorName: sql`excluded."vendorName"`,
          poDate: sql`excluded."poDate"`,
          ownerPrName: sql`excluded."ownerPrName"`,
          ownerPrId: sql`excluded."ownerPrId"`,
          // ต้องทับทุกรอบ — สถานะใบเปลี่ยนจาก Open เป็น Closed ได้ตลอดเวลาฝั่ง SAP
          // ถ้าเขียนแค่ตอน insert ค่าจะค้างที่สถานะวันแรกที่ sync มาแล้วไม่ขยับอีกเลย
          docStatus: sql`excluded."docStatus"`,
          docEntry: sql`excluded."docEntry"`,
          updatedAt: sql`now()`,
        },
      });
  }

  // บรรทัดก็ต้องยุบซ้ำเหมือน header — หลายหน้าต่างอาจคาบเกี่ยวกันจนได้บรรทัดเดิมสองครั้ง
  const lines = new Map<string, PoRow>();
  for (const r of rows) lines.set(`${docKey(r.beginStr, r.docNum)}#${r.lineNum}`, r);

  // ทับค่าเดิมเสมอ ไม่ข้าม: ตารางนี้เป็นสำเนาของ SAP ที่ AMS ไม่ได้เป็นเจ้าของ
  // ถ้าข้ามแถวที่มีอยู่แล้ว การแก้ราคา/จำนวนใน SAP จะไม่มีวันตามมาถึง AMS
  // แต่ต้องเป็น UPDATE ทับที่เดิม ห้าม delete+insert เพราะ id (uuid) ถูก asset
  // และ grpo_line อ้างอยู่ — uuid เปลี่ยนเมื่อไหร่ FK พังทั้งกระดาน
  for (const part of chunk([...lines.values()], INSERT_CHUNK)) {
    await tx
      .insert(purchaseOrderItem)
      .values(
        part.map((r) => ({
          poNumber: docKey(r.beginStr, r.docNum),
          poLine: r.lineNum,
          itemCode: toStr(r.itemCode),
          itemGroup: r.itemGroup ?? null,
          itemDescription: toStr(r.itemDescription) ?? '',
          quantity: toNum(r.quantity),
          unitPrice: toNum(r.unitPrice),
          lineTotal: toNum(r.lineTotal),
        })),
      )
      .onConflictDoUpdate({
        target: [purchaseOrderItem.poNumber, purchaseOrderItem.poLine],
        set: {
          itemCode: sql`excluded."itemCode"`,
          itemGroup: sql`excluded."itemGroup"`,
          itemDescription: sql`excluded."itemDescription"`,
          quantity: sql`excluded."quantity"`,
          unitPrice: sql`excluded."unitPrice"`,
          lineTotal: sql`excluded."lineTotal"`,
          updatedAt: sql`now()`,
        },
      });
  }

  return {
    rowsHeader: headers.size,
    rowsLine: lines.size,
    rowsSkipped: 0,
    maxUpdateDate: maxIso(rows.map((r) => toIso(r.updateDate))),
  };
}

// แถวของตารางมีคอลัมน์ครบตาม SyncState อยู่แล้ว (structural typing รับได้ตรง ๆ)
// เดิมเขียน `rows[0] as unknown as SyncState` ซึ่งกลบสองอย่างพร้อมกัน: undefined ตอน
// ไม่มีแถว และความไม่ตรงของชนิดถ้าคอลัมน์เปลี่ยนวันหลัง — requireRow จัดการตัวแรก
// ส่วนตัวที่สอง compiler ตรวจให้เองเมื่อไม่มี cast มาปิดตา
const readState = (rows: (typeof sapPurchaseOrderSync.$inferSelect)[], companyCode: string): SyncState =>
  requireRow(rows, `อ่าน sap_purchase_order_sync (companyCode=${companyCode})`);

/** base ของ advisory lock สำหรับ entity นี้ — ผสมกับบริษัทด้วย lockKeyFor() */
const LOCK_BASE = 811001;

/**
 * สร้าง connector ที่ผูกกับบริษัทหนึ่ง (0021)
 *
 * เดิมเป็น object ก้อนเดียวเพราะมีบริษัทเดียว — ตอนนี้ sync service วนสร้างตัวหนึ่ง
 * ต่อบริษัทแล้วรันแยกกัน state/event/lock จึงไม่ปนกัน
 *
 * itemGroups มาจาก company.itemGroups ของบริษัทนั้น (UBA 117 / UBP 110) ส่งเข้ามา
 * ตอนสร้างแทนที่จะให้ connector ไปอ่านเอง — ทำให้ทดสอบได้โดยไม่ต้องมีตาราง company
 */
export const makePoConnector = (companyCode: string, itemGroups: string | null): SyncConnector<PoRow[]> => ({
  // ใส่ชื่อบริษัทใน entity ด้วย — log กับ API แยกออกว่ารอบไหนของใคร
  entity: `purchase_order:${companyCode}`,
  // ต้องต่างกันต่อบริษัท ไม่งั้น UBA ที่กำลังรันจะบล็อก UBP ทั้งที่คนละฐาน
  lockKey: lockKeyFor(LOCK_BASE, companyCode),

  async fetchFloor() {
    const [row] = await sapQuery<{ minUpdateDate: Date | null }>(companyCode, poMinUpdateDate(itemGroups), {});
    return toIso(row?.minUpdateDate);
  },

  fetch: (windows) => fetchPoWindows(companyCode, itemGroups, windows),
  apply: (tx, rows) => applyPoRows(tx, companyCode, rows),

  async readState(tx) {
    const rows = await tx
      .select()
      .from(sapPurchaseOrderSync)
      .where(eq(sapPurchaseOrderSync.companyCode, companyCode));
    return readState(rows, companyCode);
  },

  async readStateOutsideTx() {
    const rows = await db
      .select()
      .from(sapPurchaseOrderSync)
      .where(eq(sapPurchaseOrderSync.companyCode, companyCode));
    // แถวแรกของบริษัทนี้ — สร้างให้ตอนใช้จริงครั้งแรก จะได้ไม่ต้องมี seed แยกที่ลืมรัน
    // (บริษัทใหม่จึงเริ่มจาก cursor ว่าง = backfill ทั้งชุด ซึ่งเป็นสิ่งที่ต้องการ)
    if (rows.length === 0) {
      const created = await db.insert(sapPurchaseOrderSync).values({ companyCode }).returning();
      return readState(created, companyCode);
    }
    return readState(rows, companyCode);
  },

  async writeState(tx, patch) {
    const now = nowIso();
    await tx
      .update(sapPurchaseOrderSync)
      .set({ ...patch, lastRunAt: now, updatedAt: now })
      .where(eq(sapPurchaseOrderSync.companyCode, companyCode));
  },

  async openEvent(tx, row) {
    const created = requireRow(
      await tx
        .insert(sapPurchaseOrderSyncEvent)
        .values({ ...row, companyCode, status: 'RUNNING' })
        .returning({ id: sapPurchaseOrderSyncEvent.id }),
      'open sap_purchase_order_sync_event',
    );
    return created.id;
  },

  async closeEvent(tx, id, row) {
    await tx
      .update(sapPurchaseOrderSyncEvent)
      .set({ ...row, finishedAt: nowIso() })
      .where(eq(sapPurchaseOrderSyncEvent.id, id));
  },

  async logFailure(row) {
    // นอกทรานแซกชันหลัก (ซึ่ง rollback ไปแล้ว) — ใช้ db ตรง ไม่ใช่ tx
    const now = nowIso();
    await db.insert(sapPurchaseOrderSyncEvent).values({
      companyCode,
      trigger: row.trigger,
      triggeredBy: row.triggeredBy,
      mode: row.mode,
      status: 'FAILED',
      error: row.error,
      sapMs: row.sapMs,
      finishedAt: now,
    });
    await db
      .update(sapPurchaseOrderSync)
      .set({ lastStatus: 'FAILED', lastError: row.error, lastRunAt: now, updatedAt: now })
      .where(eq(sapPurchaseOrderSync.companyCode, companyCode));
  },
});
