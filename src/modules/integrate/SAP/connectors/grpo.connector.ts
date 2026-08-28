// ═══════════════════════════════════════════════════════════════════════════
// connector ของ GRPO (การตรวจรับของ)
//
// ต่างจาก PO ตรงที่ต้อง "หาแม่ให้เจอ" ก่อน: grpo_line.poItemId เป็น uuid ฝั่ง AMS
// ซึ่งจะมีก็ต่อเมื่อ PO บรรทัดนั้นถูก sync มาแล้ว ระหว่าง backfill ที่ถอยหลังทีละเดือน
// GRPO เดือนนี้อาจอ้าง PO ที่ยังถอยไปไม่ถึง (สั่งไว้ปีที่แล้ว เพิ่งมาส่งของ)
// → ดึง PO ใบนั้นเฉพาะใบมาก่อน ไม่ใช่ข้ามแล้วหวังว่ารอบหลังจะเก็บ
//
// การเช็คว่าใบไหนขาด ทำในเฟส fetch (อ่านอย่างเดียว นอกทรานแซกชัน) ได้อย่างปลอดภัย
// เพราะไม่มีใครลบ purchase_order_item — ใบที่เห็นว่ามีตอนนั้นย่อมยังมีตอน apply
//
// ── ของที่หาแม่ไม่เจอจริง ๆ ไม่ได้ถูกทิ้ง
// หลังดึง PO แม่มาแล้วยังเชื่อมไม่ได้ = ตัดถาวร ไม่ใช่คิวที่รอได้ (กรณี "PO ยังถอยไม่ถึง"
// ถูกซ่อมไปแล้วในรอบเดียวกัน จึงไม่มีทางหลงมาถึงตรงนี้) แถวพวกนั้นลง sap_grpo_unlinked
// พร้อมเหตุผล — โดยเฉพาะ NOT_FROM_PO ที่อาจเป็นสินทรัพย์จริงซึ่งเข้าบริษัทโดยไม่ผ่าน
// จัดซื้อ ถ้าเก็บแค่ตัวนับก็รู้ว่ามีของหลุด แต่ไม่มีทางตามหาว่าใบไหน
// ═══════════════════════════════════════════════════════════════════════════
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import {
  grpo,
  grpoLine,
  purchaseOrderItem,
  sapGrpoSync,
  sapGrpoSyncEvent,
  sapGrpoUnlinked,
} from '@intrastucture/db/schema';
import { sapQuery, asDateTime } from '@intrastucture/sap/client';
import { grpoWindow, grpoMinUpdateDate } from '@intrastucture/sap/queries';
import type { SyncConnector, Tx, PullResult, SyncState } from '@/modules/integrate/SAP/sync.engine';
import { emptyResult } from '@/modules/integrate/SAP/sync.engine';
import { requireRow } from '@common/db-result';
import { toIso, toDateOnly, toNum, toStr, maxIso, chunk, nowIso } from '@/modules/integrate/SAP/sync.util';
import { fetchPoByDocEntries, applyPoRows, type PoRow } from './po.connector';
import { docKey, lockKeyFor } from '@/modules/integrate/SAP/company.util';

type GrpoRow = {
  docEntry: number;
  docNum: number;
  /** NNM1.BeginStr ของ GRPO ใบนี้ เช่น 'AGP-' */
  beginStr: string | null;
  docDate: Date | null;
  updateDate: Date | null;
  lineNum: number;
  itemCode: string | null;
  itemDescription: string | null;
  receivedQty: number;
  /** 22 = ก๊อปมาจาก PO / -1 = ไม่มีเอกสารต้นทาง / อื่น ๆ = เอกสารประเภทอื่น */
  baseType: number;
  // สามตัวล่างมีความหมายเฉพาะเมื่อ baseType = 22 — basePoNumber ยังเป็น null ได้อีก
  // แม้ baseType = 22 ถ้าใบ PO นั้นหายจาก OPOR แล้ว (LEFT JOIN ไม่ match)
  baseEntry: number | null;
  baseLine: number | null;
  basePoNumber: number | null;
  /**
   * ★ BeginStr ของ **PO แม่** ไม่ใช่ของ GRPO — คนละ series คนละ ObjectCode
   * ใช้ประกอบเลข PO เพื่อไปหา purchase_order_item ที่เก็บเลขพร้อม prefix ไว้แล้ว
   * ผิดตัวนี้ = resolve ไม่เจอทั้งชุด และ sync จะรายงานว่าสำเร็จโดยไม่มี grpo_line เกิดเลย
   */
  basePoBeginStr: string | null;
};

/** ก้อนที่ fetch ส่งต่อให้ apply — GRPO พร้อม PO แม่ที่ต้องเขียนลงไปก่อน */
type GrpoBatch = { rows: GrpoRow[]; parentPo: PoRow[] };

/** SAP object type ของ Purchase Order — ค่าเดียวที่แปลว่าบรรทัดนี้มี PO ต้นทางจริง */
const BASE_TYPE_PO = 22;

const INSERT_CHUNK = 500;
const LOOKUP_CHUNK = 1000;

/** คีย์ของบรรทัด PO ฝั่ง SAP → ใช้หา uuid ฝั่ง AMS */
const keyOf = (poNumber: string, poLine: number) => `${poNumber}#${poLine}`;

/** คีย์ของบรรทัด GRPO ฝั่ง SAP — DocEntry ไม่ใช่ DocNum เพราะ DocNum ซ้ำข้าม series ได้ */
const sapLineKey = (r: GrpoRow) => `${r.docEntry}#${r.lineNum}`;

/** แถวนี้มีสิทธิ์ผูกกับบรรทัด PO ได้ไหม — ถ้าไม่ ก็ไม่ต้องเสียเวลาไปค้นหา */
const linkable = (r: GrpoRow): r is GrpoRow & { baseEntry: number; baseLine: number; basePoNumber: number } =>
  r.baseType === BASE_TYPE_PO && r.basePoNumber != null && r.baseLine != null && r.baseEntry != null;

/**
 * ทำไมเชื่อมไม่ได้ — เรียงจากสาเหตุที่ "ไกลตัว" ไปหา "ใกล้ตัว"
 * เรียกเฉพาะแถวที่ resolve ไม่สำเร็จหลังดึง PO แม่มาแล้ว จึงไม่มีเคส "รอ PO" หลงมา
 */
function unlinkReason(r: GrpoRow): 'NOT_FROM_PO' | 'BASE_PO_MISSING' | 'PO_LINE_OUT_OF_SCOPE' {
  // ไม่ได้ก๊อปมาจาก PO ตั้งแต่ต้น — ไม่มีอะไรให้เชื่อมโดยนิยาม
  if (r.baseType !== BASE_TYPE_PO) return 'NOT_FROM_PO';
  // อ้าง PO อยู่ แต่ LEFT JOIN หา OPOR ไม่เจอ = ใบต้นทางไม่อยู่ใน SAP แล้ว
  if (r.basePoNumber == null) return 'BASE_PO_MISSING';
  // เหลือกรณีเดียว: ใบมีอยู่ แต่บรรทัดนั้น item อยู่นอก SAP_ITEM_GROUPS จึงไม่เคยถูก sync
  return 'PO_LINE_OUT_OF_SCOPE';
}

/** map (poNumber, poLine) → uuid ของ purchase_order_item */
async function resolvePoItemIds(
  runner: Tx | typeof db,
  poNumbers: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const part of chunk(poNumbers, LOOKUP_CHUNK)) {
    const found = await runner
      .select({ id: purchaseOrderItem.id, poNumber: purchaseOrderItem.poNumber, poLine: purchaseOrderItem.poLine })
      .from(purchaseOrderItem)
      .where(inArray(purchaseOrderItem.poNumber, part));
    for (const r of found) map.set(keyOf(r.poNumber, r.poLine), r.id);
  }
  return map;
}

/**
 * ปรับตาราง sap_grpo_unlinked ให้ตรงกับความจริงของรอบนี้
 *
 * ตารางนี้เป็นภาพ "ปัจจุบัน" ไม่ใช่ประวัติ — แถวที่รอบนี้เชื่อมได้แล้วต้องหายไป
 * (เช่นมีคนไปแก้กลุ่มสินค้าใน SAP ให้เข้าเกณฑ์ หรือเพิ่งเปิด PO ย้อนหลังให้ของที่รับไปแล้ว)
 * ถ้าไม่ลบ ตารางจะสะสมของที่แก้ไปแล้วจนไม่มีใครกล้าเชื่อตัวเลขในนั้นอีก
 *
 * firstSeenAt ไม่อยู่ใน set ของ onConflictDoUpdate โดยตั้งใจ — ต้องคงค่าเดิมไว้
 * ไม่งั้นทุกรอบจะรีเซ็ตเป็นวันนี้ แล้วคำถาม "ของชิ้นนี้ค้างมานานแค่ไหน" จะตอบไม่ได้
 */
async function syncUnlinked(
  tx: Tx,
  companyCode: string,
  resolved: GrpoRow[],
  stillUnlinked: GrpoRow[],
): Promise<void> {
  // ลบด้วย tuple (DocEntry, LineNum) ทีละคู่ — ใช้ IN สองชั้นแยกกันไม่ได้เพราะจะกลายเป็น
  // cross product แล้วลบแถวที่ไม่เกี่ยวข้องทิ้ง (เช่น 9002#1 โดนลบเพราะมี 9002#0 กับ 9003#1)
  for (const part of chunk(resolved, LOOKUP_CHUNK)) {
    // ★ tuple ต้องมี companyCode ด้วย — DocEntry เป็นเลขภายในของแต่ละฐาน
    //   ไม่ scope แล้วจะไปลบแถวของอีกบริษัทที่ DocEntry บังเอิญตรงกัน
    await tx.delete(sapGrpoUnlinked).where(
      sql`(${sapGrpoUnlinked.companyCode}, ${sapGrpoUnlinked.grpoDocEntry}, ${sapGrpoUnlinked.grpoLineNum}) IN (${sql.join(
        part.map((r) => sql`(${companyCode}, ${r.docEntry}, ${r.lineNum})`),
        sql`, `,
      )})`,
    );
  }

  for (const part of chunk(stillUnlinked, INSERT_CHUNK)) {
    await tx
      .insert(sapGrpoUnlinked)
      .values(
        part.map((r) => ({
          companyCode,
          grpoDocEntry: r.docEntry,
          grpoLineNum: r.lineNum,
          grpoNo: docKey(r.beginStr, r.docNum),
          grpoDate: toDateOnly(r.docDate),
          itemCode: toStr(r.itemCode),
          itemDescription: toStr(r.itemDescription),
          receivedQty: toNum(r.receivedQty),
          basePoNumber: r.basePoNumber == null ? null : docKey(r.basePoBeginStr, r.basePoNumber),
          baseLine: r.baseLine,
          reason: unlinkReason(r),
          sapUpdateDate: toIso(r.updateDate),
        })),
      )
      .onConflictDoUpdate({
        target: [sapGrpoUnlinked.companyCode, sapGrpoUnlinked.grpoDocEntry, sapGrpoUnlinked.grpoLineNum],
        set: {
          grpoNo: sql`excluded."grpoNo"`,
          grpoDate: sql`excluded."grpoDate"`,
          itemCode: sql`excluded."itemCode"`,
          itemDescription: sql`excluded."itemDescription"`,
          receivedQty: sql`excluded."receivedQty"`,
          basePoNumber: sql`excluded."basePoNumber"`,
          baseLine: sql`excluded."baseLine"`,
          // เหตุผลเปลี่ยนได้ระหว่างทาง เช่น PO ถูกลบทีหลัง PO_LINE_OUT_OF_SCOPE → BASE_PO_MISSING
          reason: sql`excluded."reason"`,
          sapUpdateDate: sql`excluded."sapUpdateDate"`,
          lastSeenAt: sql`now()`,
        },
      });
  }
}

/**
 * เขียน GRPO ลง ams_db
 *
 * แยกออกมาเป็นฟังก์ชันเดี่ยวตอนทำหลายบริษัท (0021) เพราะตัว connector กลายเป็น factory
 * ที่ผูก companyCode ไว้แล้ว — ตัว apply จึงต้องรับ companyCode เข้ามาตรง ๆ
 */
async function applyGrpoBatch(tx: Tx, companyCode: string, { rows, parentPo }: GrpoBatch): Promise<PullResult> {
  if (rows.length === 0) return emptyResult();

  // PO แม่ต้องลงก่อนเสมอ ไม่งั้น grpo_line ชี้ไปหา uuid ที่ยังไม่มี
  await applyPoRows(tx, companyCode, parentPo);

  const poNumbers = [...new Set(rows.filter(linkable).map((r) => docKey(r.basePoBeginStr, r.basePoNumber)))];
  const poItemIds = poNumbers.length > 0 ? await resolvePoItemIds(tx, poNumbers) : new Map<string, string>();

  // ── คัดแยกเป็นสองกอง พร้อมยุบซ้ำระดับบรรทัด SAP ในรอบเดียว
  //
  // ต้องยุบซ้ำตรงนี้เพราะหน้าต่างสองก้อนอาจคาบเกี่ยวกันจนได้บรรทัดเดิมมาสองครั้ง
  // ถ้าปล่อยไว้ ฝั่ง linked จะบวกจำนวนเกินจริง และฝั่ง unlinked จะทำให้ upsert
  // ชุดเดียวมี key ซ้ำจน pg ปฏิเสธทั้งคำสั่ง
  //
  // กองที่ resolve ไม่ได้ = ตัดถาวร ไม่ใช่คิวที่รอได้ เพราะ PO แม่ที่ยังไม่ถูก sync
  // ถูกดึงมาเขียนไปแล้วที่บรรทัดบน (applyPoRows) ก่อนจะมาถึงตรงนี้
  const linked = new Map<string, GrpoRow>();
  const unlinked = new Map<string, GrpoRow>();
  for (const r of rows) {
    const k = sapLineKey(r);
    if (linked.has(k) || unlinked.has(k)) continue;
    const poItemId = linkable(r)
      ? poItemIds.get(keyOf(docKey(r.basePoBeginStr, r.basePoNumber), r.baseLine))
      : undefined;
    if (poItemId) linked.set(k, r);
    else unlinked.set(k, r);
  }

  // watermark ต้องคิดจาก rows ทั้งหมด ไม่ใช่แค่ที่เขียนสำเร็จ — ไม่งั้นรอบที่มีแต่ของ
  // ที่เชื่อมไม่ได้จะไม่เลื่อน watermark แล้ววนดึงช่วงเดิมซ้ำตลอดไป
  const maxUpdateDate = maxIso(rows.map((r) => toIso(r.updateDate)));

  await syncUnlinked(tx, companyCode, [...linked.values()], [...unlinked.values()]);

  const skipped = unlinked.size;
  if (linked.size === 0) return { ...emptyResult(), rowsSkipped: skipped, maxUpdateDate };

  // ── header (ยุบซ้ำก่อน — SAP คืนหนึ่งแถวต่อบรรทัด)
  const headers = new Map<string, GrpoRow>();
  for (const r of linked.values()) headers.set(docKey(r.beginStr, r.docNum), r);

  // grpo.id เป็น serial ฝั่ง AMS — อ่าน id ของใบที่มีอยู่แล้ว "ก่อน" เขียน (เดิมอ่านหลัง)
  // นอกจากใช้ผูก line แล้ว ยังเป็นตัวแยกว่าใบไหนใหม่ใบไหนเก่า
  const grpoIds = new Map<string, number>();
  for (const part of chunk([...headers.keys()], LOOKUP_CHUNK)) {
    const found = await tx
      .select({ id: grpo.id, grpoNo: grpo.grpoNo })
      .from(grpo)
      .where(inArray(grpo.grpoNo, part));
    for (const r of found) grpoIds.set(r.grpoNo, r.id);
  }

  const headerRows = [...headers.values()].map((r) => ({
    grpoNo: docKey(r.beginStr, r.docNum),
    companyCode,
    docEntry: r.docEntry,
    // grpoDate เป็น NOT NULL — SAP ไม่เคยปล่อยว่าง แต่กันไว้ด้วย UpdateDate
    grpoDate: toDateOnly(r.docDate) ?? toDateOnly(r.updateDate) ?? nowIso().slice(0, 10),
  }));

  // ── แยกทางเขียนสองสาย ด้วยเหตุผลเดียวกับ asset.connector:
  // INSERT ... ON CONFLICT ดึงค่า default ของทุกแถวที่เสนอเข้าไปก่อนจะรู้ว่าชน แปลว่า
  // grpo_id_seq ถูกกินทุกแถวทุกรอบ sync ทั้งที่ส่วนใหญ่เป็นใบเดิม (ตอนตรวจพบ seq อยู่ที่
  // 256 ทั้งที่มีใบจริง 154 ใบ) — ของเดิมจึงต้องเป็น UPDATE ที่ไม่แตะ default ของ id
  const toInsert = headerRows.filter((h) => !grpoIds.has(h.grpoNo));
  const toUpdate = headerRows.filter((h) => grpoIds.has(h.grpoNo));

  for (const part of chunk(toInsert, INSERT_CHUNK)) {
    // onConflictDoUpdate เหลือไว้เป็นตาข่ายกันใบที่โผล่มาระหว่างที่เราอ่านกับตอนเขียน
    // returning ทำให้ไม่ต้องวนอ่าน id กลับอีกรอบ (ได้ทั้งเส้น insert และเส้นที่ชน)
    const written = await tx
      .insert(grpo)
      .values(part)
      .onConflictDoUpdate({
        target: grpo.grpoNo,
        set: {
          grpoDate: sql`excluded."grpoDate"`,
          docEntry: sql`excluded."docEntry"`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ id: grpo.id, grpoNo: grpo.grpoNo });
    for (const r of written) grpoIds.set(r.grpoNo, r.id);
  }

  for (const part of chunk(toUpdate, INSERT_CHUNK)) {
    // cast ชนิดกำกับทุกค่า — parameter ที่ส่งเข้า VALUES เป็น unknown ฝั่ง pg
    const rows = part.map((h) => sql`(${h.grpoNo}::varchar, ${h.grpoDate}::date, ${h.docEntry}::integer)`);
    await tx.execute(sql`
      UPDATE ${grpo} AS g
         SET "grpoDate" = v."grpoDate", "docEntry" = v."docEntry", "updatedAt" = now()
      FROM (VALUES ${sql.join(rows, sql`, `)}) AS v("grpoNo", "grpoDate", "docEntry")
      WHERE g."grpoNo" = v."grpoNo"
    `);
  }

  // ── line: ยุบเป็นระดับ (รอบรับ × po line) ตามที่ตาราง grpo_line นิยามไว้
  // GRPO ใบเดียวอาจมีหลายบรรทัดที่อ้าง PO บรรทัดเดียวกัน (แยกตาม bin/serial ฝั่ง SAP)
  // ซึ่งของเราถือเป็นการรับรอบเดียวกัน → รวมจำนวน ไม่ใช่ทับกันเอง
  // (การกันแถวซ้ำข้ามหน้าต่างทำไปแล้วตอนคัดแยก linked/unlinked ข้างบน)
  const lines = new Map<string, { grpoId: number; poItemId: string; receivedQty: number }>();
  for (const r of linked.values()) {
    const grpoId = grpoIds.get(docKey(r.beginStr, r.docNum));
    const poItemId = linkable(r)
      ? poItemIds.get(keyOf(docKey(r.basePoBeginStr, r.basePoNumber), r.baseLine))
      : undefined;
    if (grpoId == null || poItemId == null) continue;

    const k = `${grpoId}#${poItemId}`;
    const prev = lines.get(k);
    if (prev) prev.receivedQty += toNum(r.receivedQty);
    else lines.set(k, { grpoId, poItemId, receivedQty: toNum(r.receivedQty) });
  }

  for (const part of chunk([...lines.values()], INSERT_CHUNK)) {
    await tx
      .insert(grpoLine)
      .values(part)
      .onConflictDoUpdate({
        target: [grpoLine.grpoId, grpoLine.poItemId],
        set: { receivedQty: sql`excluded."receivedQty"`, updatedAt: sql`now()` },
      });
  }

  return { rowsHeader: headers.size, rowsLine: lines.size, rowsSkipped: skipped, maxUpdateDate };
}

// เหตุผลเดียวกับฝั่ง po.connector — ไม่ cast แต่ให้ requireRow ตรวจจริง
const readState = (rows: (typeof sapGrpoSync.$inferSelect)[], companyCode: string): SyncState =>
  requireRow(rows, `อ่าน sap_grpo_sync (companyCode=${companyCode})`);

/** base ของ advisory lock สำหรับ entity นี้ — ผสมกับบริษัทด้วย lockKeyFor() */
const LOCK_BASE = 811002;

/** สร้าง connector ที่ผูกกับบริษัทหนึ่ง (0021) — ดูเหตุผลเต็มที่ makePoConnector */
export const makeGrpoConnector = (companyCode: string, itemGroups: string | null): SyncConnector<GrpoBatch> => ({
  entity: `grpo:${companyCode}`,
  lockKey: lockKeyFor(LOCK_BASE, companyCode),

  async fetchFloor() {
    const [row] = await sapQuery<{ minUpdateDate: Date | null }>(companyCode, grpoMinUpdateDate(itemGroups), {});
    return toIso(row?.minUpdateDate);
  },

  async fetch(windows) {
    const rows: GrpoRow[] = [];
    for (const w of windows) {
      rows.push(
        ...(await sapQuery<GrpoRow>(companyCode, grpoWindow(itemGroups), {
          from: asDateTime(w.from),
          to: asDateTime(w.to),
        })),
      );
    }
    if (rows.length === 0) return { rows, parentPo: [] };

    // เช็คว่า PO แม่ใบไหนยังไม่มีใน AMS แล้วดึงเฉพาะใบนั้น
    //
    // คิดเฉพาะแถวที่ผูกได้จริง — แถว BaseType ≠ 22 มี BaseEntry เป็น -1 ซึ่งเอาไปดึงไม่ได้
    // (docEntryList กรองเลขติดลบทิ้ง แล้วถ้าเหลือศูนย์ตัวจะโยน error กลางรอบ sync)
    const linkableRows = rows.filter(linkable);
    const poNumbers = [...new Set(linkableRows.map((r) => docKey(r.basePoBeginStr, r.basePoNumber)))];
    const existing = poNumbers.length > 0 ? await resolvePoItemIds(db, poNumbers) : new Map<string, string>();
    const missing = [
      ...new Set(
        linkableRows
          .filter((r) => !existing.has(keyOf(docKey(r.basePoBeginStr, r.basePoNumber), r.baseLine)))
          .map((r) => r.baseEntry),
      ),
      // กัน DocEntry ที่ใช้ไม่ได้หลุดเข้าไป: docEntryList จะกรองเลขติดลบทิ้งแล้วโยน error
      // ถ้าเหลือศูนย์ตัว ซึ่งจะทำให้ทั้งรอบพังเพราะแถวเดียวที่ข้อมูลเพี้ยน
    ].filter((n) => Number.isInteger(n) && n > 0);
    const parentPo = await fetchPoByDocEntries(companyCode, itemGroups, missing);

    return { rows, parentPo };
  },

  apply: (tx, batch) => applyGrpoBatch(tx, companyCode, batch),

  async readState(tx) {
    const rows = await tx.select().from(sapGrpoSync).where(eq(sapGrpoSync.companyCode, companyCode));
    return readState(rows, companyCode);
  },

  async readStateOutsideTx() {
    const rows = await db.select().from(sapGrpoSync).where(eq(sapGrpoSync.companyCode, companyCode));
    if (rows.length === 0) {
      const created = await db.insert(sapGrpoSync).values({ companyCode }).returning();
      return readState(created, companyCode);
    }
    return readState(rows, companyCode);
  },

  async writeState(tx, patch) {
    const now = nowIso();
    await tx
      .update(sapGrpoSync)
      .set({ ...patch, lastRunAt: now, updatedAt: now })
      .where(eq(sapGrpoSync.companyCode, companyCode));
  },

  async openEvent(tx, row) {
    const created = requireRow(
      await tx
        .insert(sapGrpoSyncEvent)
        .values({ ...row, companyCode, status: 'RUNNING' })
        .returning({ id: sapGrpoSyncEvent.id }),
      'open sap_grpo_sync_event',
    );
    return created.id;
  },

  async closeEvent(tx, id, row) {
    await tx
      .update(sapGrpoSyncEvent)
      .set({ ...row, finishedAt: nowIso() })
      .where(eq(sapGrpoSyncEvent.id, id));
  },

  async logFailure(row) {
    const now = nowIso();
    await db.insert(sapGrpoSyncEvent).values({
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
      .update(sapGrpoSync)
      .set({ lastStatus: 'FAILED', lastError: row.error, lastRunAt: now, updatedAt: now })
      .where(eq(sapGrpoSync.companyCode, companyCode));
  },
});
