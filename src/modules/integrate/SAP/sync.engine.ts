// ═══════════════════════════════════════════════════════════════════════════
// แกนกลางของการ sync — ขั้นตอนเหมือนกันหมดทุก entity ต่างกันแค่ SQL ฝั่ง SAP
// กับตารางปลายทาง ซึ่งเป็นหน้าที่ของ connector (ดู connectors/)
//
// หนึ่งรอบทำสองอย่าง:
//   1) ขอบหน้า  — ตามของที่ใหม่/เพิ่งแก้ตั้งแต่ watermark (ไม่กี่แถว)
//   2) ขอบหลัง  — ถอยเก็บอดีตทีละหน้าต่าง จนถึง floor แล้วเลิก
// ทำสองอย่างในรอบเดียวเพราะ backfill ทั้งประวัติกินเวลาหลายวัน ระหว่างนั้น
// ผู้ใช้ต้องเห็นของใหม่ด้วย ไม่ใช่รอ backfill จบก่อน
//
// ทำไมถอยหลังไม่ใช่เดินหน้า: ข้อมูลมีหลายปี ถ้าไล่จากเก่าไปใหม่ กว่าจะถึงเดือน
// ปัจจุบัน (ตัวที่คนใช้จริง) ต้องรอหลายวัน — ถอยหลังทำให้รอบแรกได้ของที่ใช้งานได้เลย
//
// ── ลำดับที่ต้องรักษาไว้: ดึงจาก SAP ให้เสร็จก่อน แล้วค่อยเปิดทรานแซกชันเขียน
// ถ้าเปิดทรานแซกชันคร่อมการรอ SAP (ซึ่งรอได้ถึง 2 นาทีตาม requestTimeout)
// ams_db จะถูกจับล็อกค้างไว้ทั้งช่วงนั้น — ผู้ใช้ที่กำลังลงทะเบียน asset ของ PO
// เดียวกันจะค้างตามไปด้วย ทั้งที่เรากำลังรอเครื่องอื่นอยู่เฉย ๆ
//
// ── สามด่านที่กันการรันซ้ำซ้อน เรียงจากถูกที่สุดไปแพงที่สุด
//   1) advisory lock แบบ session  — จองก่อนแตะอะไรทั้งสิ้น รอบที่แพ้ไม่เสียแม้แต่ query เดียว
//   2) cooldown จาก lastRunAt      — กัน "กดถี่" ที่ล็อกกันไม่ได้ เพราะรอบก่อนจบไปแล้ว
//   3) เทียบ updatedAt ในทรานแซกชัน — ตาข่ายชั้นสุดท้าย ดักคนแก้ state ตรง ๆ นอก engine
// ═══════════════════════════════════════════════════════════════════════════
import { db, pool } from '@intrastucture/db';
import { env } from '@config/env';
import { describeError, nowIso } from './sync.util';
import type {
  PullResult,
  SyncConnector,
  SyncMode,
  SyncOutcome,
  SyncState,
  SyncTrigger,
  SyncWindow,
} from './sync.types';

// ชนิดทั้งหมดย้ายไป sync.types.ts แล้ว — re-export ไว้เพื่อให้ที่เรียกเดิมไม่ต้องแก้
// (engine ยังเป็น "ประตู" ของ sync ตามเดิม แค่ไม่ได้เป็นเจ้าของนิยามชนิดอีกต่อไป)
export type {
  SyncTrigger,
  SyncMode,
  Tx,
  SyncWindow,
  SyncState,
  PullResult,
  SyncStatus,
  SyncStatePatch,
  OpenEventRow,
  CloseEventRow,
  FailureRow,
  SyncConnector,
  SyncOutcome,
} from './sync.types';

export const emptyResult = (): PullResult => ({
  rowsHeader: 0,
  rowsLine: 0,
  rowsSkipped: 0,
  maxUpdateDate: null,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** ถอยหลังหนึ่งหน้าต่าง แต่ไม่ให้เลย floor (ก้อนสุดท้ายจะสั้นกว่าปกติ) */
function stepBack(to: Date, floor: Date): Date {
  const from = new Date(to.getTime() - env.SAP_BACKFILL_WINDOW_DAYS * DAY_MS);
  return from < floor ? floor : from;
}

/** ค่าที่มากกว่าในรูป ISO — null ถือว่าน้อยกว่าเสมอ */
function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * ผูก connector เข้ากับ runSync แล้วซ่อนชนิดของก้อนข้อมูลไว้ข้างใน
 *
 * จำเป็นเพราะ B โผล่ทั้งฝั่งรับและฝั่งคืน (fetch คืน B / apply รับ B) ทำให้
 * SyncConnector<PoRow[]> กับ SyncConnector<GrpoBatch> ไม่มี supertype ร่วม
 * เก็บ connector หลายตัวไว้ใน object เดียวจึงต้องผ่านตัวห่อแบบนี้ ไม่ใช่หนีไปใช้ any
 */
export type BoundSync = (trigger: SyncTrigger, triggeredBy?: number | null) => Promise<SyncOutcome>;

export const bindSync =
  <B>(c: SyncConnector<B>): BoundSync =>
  (trigger, triggeredBy = null) =>
    runSync(c, trigger, triggeredBy);

export async function runSync<B>(
  c: SyncConnector<B>,
  trigger: SyncTrigger,
  triggeredBy: number | null = null,
): Promise<SyncOutcome> {
  let modeForLog: SyncMode = 'BACKFILL';

  // performance.now ไม่ใช่ Date.now — เป็นนาฬิกาเดินหน้าอย่างเดียว ไม่กระโดดตาม NTP
  // ที่อาจปรับเวลาระหว่างที่เรารอ SAP อยู่ (ซึ่งเป็นช่วงที่ยาวที่สุดของรอบพอดี)
  const startedAt = performance.now();
  // ตั้งค่าเมื่อ fetch จบ — ทางพังอ่านตัวนี้เพื่อแยกว่า "พังตอนคุยกับ SAP" (ยังเป็น null)
  // หรือ "พังตอนเขียน DB" (มีค่าแล้ว) ซึ่งเป็นคนละปัญหากันคนละเรื่อง
  let sapMs: number | null = null;

  try {
    // ── เฟส 0: จองสิทธิ์ก่อนแตะอะไรทั้งสิ้น
    //
    // ต้องจองเส้น connection ไว้เองแทนที่จะใช้ db: advisory lock แบบ session ผูกกับ
    // connection ถ้าปล่อยให้ pool หยิบเส้นใหม่ทุกคำสั่ง ล็อกกับปลดล็อกจะไปอยู่คนละเส้น
    // แล้วค้างถาวรจนกว่าจะรีสตาร์ทแอป
    //
    // ทำไมเป็น session ไม่ใช่ xact แบบเดิม: xact lock ต้องมีทรานแซกชันเปิดค้างไว้ ซึ่ง
    // แปลว่าต้องเปิด tx คร่อมการรอ SAP ทั้ง 2 นาที — คือสิ่งที่ทั้งไฟล์นี้ตั้งใจเลี่ยง
    // แบบ session ถือข้ามเฟสได้โดยไม่มี tx เปิดอยู่เลย เราจึงจองสิทธิ์ได้ "ก่อน" ยิง SAP
    // รอบที่จะแพ้อยู่แล้วเลยเด้งกลับตั้งแต่ต้น ไม่ต้องเสียเวลารีด ERP ของบริษัทฟรี ๆ
    //
    // process ตายกลางคัน = connection ขาด = pg ปลดล็อกให้เอง ไม่มีล็อกค้างข้ามรอบ
    const client = await pool.connect();
    let locked = false;

    try {
      const claim = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [c.lockKey]);
      locked = claim.rows[0]?.locked === true;
      // try_ = ไม่รอคิว ปุ่มที่กดตอนอีกรอบกำลังทำงานจะเด้งกลับทันทีแทนที่จะค้าง
      if (!locked) return { status: 'SKIPPED', reason: `sync ${c.entity} กำลังทำงานอยู่` };

      // ── เฟส 1: อ่านสถานะ + ดึงจาก SAP (นอกทรานแซกชัน)
      const st = await c.readStateOutsideTx();
      modeForLog = st.mode;

      // ── กันกดรัว: ล็อกข้างบนกันได้แค่ "รันซ้อนกัน" ไม่ได้กัน "กดถี่"
      // รอบที่จบไปเมื่อ 2 วินาทีที่แล้วแทบไม่มีทางมีของใหม่ให้ดึง กดซ้ำจึงเป็นการรีด SAP
      // เปล่า ๆ — lastRunAt คือเวลาที่รอบล่าสุด "จบ" (เขียนทั้งทางสำเร็จและทางพัง)
      const cooldownMs = env.SAP_SYNC_COOLDOWN_SECONDS * 1000;
      if (cooldownMs > 0 && st.lastRunAt) {
        const sinceMs = new Date(nowIso()).getTime() - new Date(st.lastRunAt).getTime();
        // sinceMs ติดลบได้ถ้านาฬิกาถูกปรับถอย — ถือว่าเพิ่งรันไป ปลอดภัยกว่าปล่อยผ่าน
        if (sinceMs < cooldownMs) {
          const waitSec = Math.ceil((cooldownMs - sinceMs) / 1000);
          return { status: 'SKIPPED', reason: `sync ${c.entity} เพิ่งรันไป — รออีก ${waitSec} วินาที` };
        }
      }

      // รอบแรกยังไม่รู้ว่าประวัติเริ่มตรงไหน — ถามครั้งเดียวแล้วจำไว้
      const floor = st.backfillFloor ?? (st.mode === 'BACKFILL' ? await c.fetchFloor() : null);

      const windows: SyncWindow[] = [];

      // (ก) ขอบหน้า — ทำเฉพาะเมื่อมี watermark แล้วเท่านั้น
      //
      // รอบแรก (lastUpdateDate ยังเป็น null) ห้ามดึงตรงนี้เด็ดขาด: from=null + to=null
      // แปลว่าไม่จำกัดทั้งสองด้าน = ลากทั้ง OPOR สองหมื่นกว่าใบมาในทีเดียว ซึ่งตรงข้าม
      // กับที่ทั้งระบบตั้งใจทำ (ทยอยทีละเดือน) และเป็นภาระหนักกับ SAP ที่เป็น production
      // รอบแรกให้ขอบหลังก้อนแรกเป็นคนตั้ง watermark ให้แทน (ก้อนนั้นคือเดือนล่าสุดพอดี)
      if (st.lastUpdateDate) windows.push({ from: st.lastUpdateDate, to: null });

      // (ข) ขอบหลัง — ถอยอดีตทีละก้อน
      let mode = st.mode;
      let cursor = st.backfillCursor;
      let floorToStore = floor;
      // ใช้เฉพาะตอนไม่มีประวัติให้ถอย เพื่อไม่ให้ watermark ค้าง null (ดูเหตุผลข้างล่าง)
      let seedWatermark: string | null = null;

      if (mode === 'BACKFILL') {
        if (floor) {
          // nowIso ไม่ใช่ new Date(): ขอบบนก้อนนี้ถูกเทียบกับ UpdateDate ของ SAP ซึ่งเก็บ
          // ตามกติกา "wall clock แปะ Z" — ใช้ instant จริงจะได้ขอบที่ช้ากว่านาฬิกา SAP
          // ตาม offset ของเครื่อง (บน UTC+7 คือ 7 ชม.) แล้วก้อนแรกจะไม่ครอบของที่เพิ่งเข้า
          const to = new Date(cursor ?? nowIso());
          const from = stepBack(to, new Date(floor));
          windows.push({ from: from.toISOString(), to: to.toISOString() });
          cursor = from.toISOString();
          // ถึงพื้นแล้ว = เก็บครบทั้งประวัติ เลิกถอย เหลือแต่ตามของใหม่รอบละไม่กี่แถว
          if (from <= new Date(floor)) mode = 'INCREMENTAL';
        } else {
          // floor เป็น null = ฝั่ง SAP ไม่มีแถวที่ผ่านตัวกรองเลยสักแถว (เคสที่เกิดจริงคือ
          // SAP_ITEM_GROUPS ตั้งเลขผิด) ห้ามปล่อยให้ถอยต่อ: stepBack ไม่มีพื้นให้หยุด
          // mode จะค้าง BACKFILL ตลอดกาล cursor ไต่ลงอดีตทีละเดือนไม่รู้จบ และ fetchFloor()
          // (MIN() ที่ scan ทั้งตารางบน ERP ของบริษัท) จะถูกยิงซ้ำทุกรอบ โดยที่ lastStatus
          // ยังขึ้น SUCCESS สวย ๆ ไม่มีอะไรบอกว่าผิด
          //
          // ปักพื้นไว้ที่ "ตอนนี้" แล้วสลับไปตามของใหม่แทน — ไม่มีอดีตให้เก็บก็ไม่ต้องเก็บ
          // ต้องตั้ง watermark ด้วย ไม่งั้นขอบหน้าจะไม่ทำงาน (เงื่อนไขที่ ก) แล้วตายสนิท
          // ไม่มีวันเห็นข้อมูลที่เข้ามาทีหลัง; ของที่เข้าหลังจากนี้ UpdateDate ย่อมไม่ต่ำกว่านี้
          floorToStore = nowIso();
          seedWatermark = floorToStore;
          mode = 'INCREMENTAL';
        }
      }

      // windows ว่างได้ (เคสข้างบน) — ไม่ return ทิ้งกลางทาง เพราะต้องเข้าไปเขียน mode/floor
      // ที่เพิ่งตัดสินใจลง state ให้ได้ ไม่งั้นรอบหน้าจะกลับมาคิดใหม่แล้วยิง SAP ซ้ำตลอดไป
      // (fetch([]) ไม่ยิง SAP เลย — ลูปในตัว connector ไม่มีรอบให้วน)
      const batch = await c.fetch(windows);

      // ปิดหน้าปัดฝั่ง SAP ตรงนี้ — ทุกอย่างหลังจากนี้เป็นงานของ ams_db ล้วน
      sapMs = Math.round(performance.now() - startedAt);

      // ── เฟส 2: เขียนลง ams_db (ในทรานแซกชัน — สั้นที่สุดเท่าที่ทำได้)
      let outcome: SyncOutcome = { status: 'SKIPPED', reason: 'not started' };
      const measuredSapMs = sapMs;

      await db.transaction(async (tx) => {
        const txStartedAt = performance.now();

        // ไม่มี advisory lock ตรงนี้แล้ว — เราถือแบบ session อยู่ตั้งแต่ก่อนยิง SAP ซึ่ง
        // ครอบช่วงนี้อยู่ด้วย ถ้าขอ xact lock เลขเดียวกันซ้ำจะชนกับล็อกของตัวเองเสียเปล่า
        //
        // ด่านล่างนี้จึงเหลือไว้เป็นตาข่ายชั้นสอง ไม่ใช่ตัวกันหลักอีกต่อไป: ดักกรณีที่มี
        // ใครแก้แถว state ตรง ๆ นอก engine (เช่น admin รัน UPDATE เอง) ระหว่างที่เรารอ SAP
        // ถ้าเขียนทับด้วยหน้าต่างที่คำนวณจากค่าเก่า cursor จะถอยกลับ/กระโดดข้ามช่วง
        const fresh = await c.readState(tx);
        if (fresh.updatedAt !== st.updatedAt) {
          outcome = { status: 'SKIPPED', reason: 'มีอีกรอบเขียนสถานะไปแล้วระหว่างดึงข้อมูล' };
          return;
        }

        const eventId = await c.openEvent(tx, { trigger, triggeredBy, mode: st.mode });
        const result = await c.apply(tx, batch);

        // watermark เลื่อนในทรานแซกชันเดียวกับข้อมูล — พังกลางคันแล้ว rollback ทั้งคู่
        // รอบหน้าเริ่มที่เดิม ไม่มีแถวหายและไม่ต้องมีใครมาตามซ่อม
        // เดินหน้าอย่างเดียว (laterIso) — หน้าต่างที่ถอยหลังต้องไม่ดึง watermark ให้ถอยตาม
        const watermark = laterIso(laterIso(st.lastUpdateDate, seedWatermark), result.maxUpdateDate);

        await c.writeState(tx, {
          lastUpdateDate: watermark,
          backfillCursor: cursor,
          backfillFloor: floorToStore,
          mode,
          lastStatus: 'SUCCESS',
          lastError: null,
        });

        await c.closeEvent(tx, eventId, {
          ...result,
          status: 'SUCCESS',
          error: null,
          watermarkFrom: st.lastUpdateDate,
          watermarkTo: watermark,
          sapMs: measuredSapMs,
          // วัดถึงก่อน COMMIT — เวลา commit จริงไม่รวมอยู่ในนี้ (หลักมิลลิวินาที) เพราะ
          // closeEvent เป็นคำสั่งสุดท้ายที่ยังเขียนได้ ถ้าไปวัดหลัง COMMIT ก็ไม่มีที่เก็บแล้ว
          txMs: Math.round(performance.now() - txStartedAt),
        });

        outcome = { status: 'SUCCESS', ...result, mode, backfillCursor: cursor };
      });

      return outcome;
    } finally {
      // ปลดล็อกก่อนคืน connection เสมอ ไม่ว่าจะจบทางไหน — ถ้าคืนเส้นเข้า pool ทั้งที่ยัง
      // ถือล็อกอยู่ คนถัดไปที่หยิบเส้นนั้นจะถือล็อกของเราติดไปด้วยโดยไม่รู้ตัว
      // (.catch เงียบ: ถ้าปลดไม่ได้เพราะ connection ขาดไปแล้ว pg ก็ปลดให้เองอยู่ดี
      //  และไม่ควรให้ error ตรงนี้ไปกลบสาเหตุจริงที่ทำให้หลุดออกมาจาก try)
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [c.lockKey]).catch(() => {});
      client.release();
    }
  } catch (e) {
    // ทรานแซกชันข้างบน rollback ไปแล้ว รวมถึงแถว event ที่เพิ่งเปิด — ต้องเขียนใหม่
    // นอกทรานแซกชัน ไม่งั้นรอบที่พังจะหายไปเงียบ ๆ แล้วไม่มีใครรู้ว่า sync ตายมากี่วัน
    // describeError ดึงสาเหตุจริงจาก cause และตัดข้อมูลบริษัทที่ drizzle แนบมากับ message ทิ้ง
    const message = describeError(e);

    // ห่อไว้เพราะ logFailure เองก็พังได้ (ams_db ล่มทั้งเครื่อง / connection pool หมด)
    // ถ้าปล่อยให้มันโยนออกไป error ของ "การบันทึก" จะแทนที่ error ต้นฉบับ แล้ว throw
    // บรรทัดล่างไม่มีวันได้ทำงาน — คนดูจะเห็นแค่ "เขียน log ไม่ได้" ไม่เห็นว่า sync พังเพราะอะไร
    // ตกลง console แทน อย่างน้อยยังมีร่องรอยว่าเกิดสองเรื่องซ้อนกัน
    try {
      await c.logFailure({
        trigger,
        triggeredBy,
        mode: modeForLog,
        error: message,
        // ยังไม่มีค่า = พังก่อน fetch จบ ใช้เวลาที่ผ่านไปจนถึงตอนพังแทน (เช่น SAP timeout
        // จะได้ ~120000 ส่วนต่อไม่ติดจะได้หลักพัน) — สองอย่างนี้แก้คนละทางกัน
        sapMs: sapMs ?? Math.round(performance.now() - startedAt),
      });
    } catch (logError) {
      console.error(
        `❌ sync ${c.entity}: บันทึกรอบที่พังลง ams_db ไม่สำเร็จ ${describeError(logError)}`,
      );
      console.error(`   สาเหตุเดิมที่ทำให้รอบนี้พัง: ${message}`);
    }

    // โยนต่อเสมอ ไม่ว่าการบันทึกจะสำเร็จหรือไม่ — ปุ่มต้องได้ 500 กลับไป และ syncAll
    // ต้องรู้ว่า entity นี้พังเพื่อไปเขียนลงผลลัพธ์ ไม่ใช่กลืนแล้วรายงานว่าสำเร็จ
    throw e;
  }
}
