// ═══════════════════════════════════════════════════════════════════════════
// flow ที่ 2: แจ้งผลกลับผู้ขอ — อีเมลทางเดียว ไม่มีการ์ดให้กด
//
// ยิงตอนบัญชีกด "ยืนยันและแจ้งกลับไปยังผู้ขอ" ปุ่มเดียว ออกได้สองหน้า:
//   COMPLETE  ปิดงาน — ทุกชิ้นได้เลขแล้ว (แนบตารางเลขสินทรัพย์)
//   REJECTED  ยังไม่จบ — มีชิ้นที่บัญชีตีกลับ (แนบเหตุผลรายชิ้น + ทางเข้าไปแก้)
//
// ★ ทำไมแจ้งตอนกดปุ่ม ไม่ใช่ตอนกดตีกลับรายชิ้น: การตีกลับเป็นรายชิ้น ใบที่มี 20 ชิ้นจะยิง
//   อีเมล 20 ฉบับระหว่างที่บัญชีไล่ตรวจ ผู้ขอได้เมลรัวโดยที่งานยังไม่จบสักรอบ — ย้ายมาที่
//   ปุ่มเดียวตอนบัญชีตรวจครบใบ = ผู้ขอได้ฉบับเดียวต่อรอบ พร้อมรายการที่ต้องแก้ทั้งหมด
//
// ★ คนละ flow กับ sendToManager.ts จึงคนละ URL (ดูเหตุผลเต็มที่หัวไฟล์นั้น)
//   ส่วนสองเคสในไฟล์นี้ใช้ flow เดียวกัน แตกทางด้วย `kind` — ผู้รับคนเดียวกัน ปลายทาง
//   เดียวกัน ต่างกันแค่เนื้อความ ⚠️ ฝั่ง Power Automate ต้องแตกทางที่ `kind` เท่านั้น
//   ห้ามเดาจาก "ช่องไหนไม่ว่าง" เพราะเมล REJECTED มีตารางชิ้นที่ได้เลขแล้วติดไปด้วย
// ═══════════════════════════════════════════════════════════════════════════
import { env } from '@config/env';
import { esc, postToFlow, type SendResult } from './shared';

/** URL ของ flow แจ้งผลกลับผู้ขอ — คนละตัวกับ POWER_AUTOMATE_URL ของ flow ขออนุมัติ */
function requesterFlowUrl(): string {
  return env.POWER_AUTOMATE_REQUESTER_URL.trim();
}

/** ชิ้นที่ได้เลขแล้ว — ผู้ขอเอาไปตรวจรับ/ติดป้ายต่อได้เลย */
export interface RegisteredAssetLine {
  assetNumber: string;
  description: string;
  serialNumber: string;
  location: string;
  /** ผู้ถือครอง — 'ไม่ระบุ (ของกลาง)' เมื่อไม่ได้ผูกกับใคร ไม่ใช่ค่าว่าง (คนละความหมาย) */
  ownerName: string;
}

/** ชิ้นที่บัญชีตีกลับ — ต้องบอกว่าชิ้นไหนและเพราะอะไร ไม่งั้นผู้ขอไม่รู้จะแก้อะไร */
export interface RejectedAssetLine {
  /** เลขชิ้นที่คนอ่าน เช่น "1.2" (poLine.unitNo) — ชิ้นยังไม่มีเลขสินทรัพย์ให้อ้าง */
  unitLabel: string;
  description: string;
  serialNumber: string;
  reason: string;
  ownerName: string; 
}

/** ชิ้นที่ถูกปิดถาวร — ต้องอยู่ในเมลด้วย ไม่งั้นผู้ขอขอมา 5 ได้ 3 โดยไม่มีใครบอกว่าทำไม */
export interface CancelledAssetLine {
  unitLabel: string;
  description: string;
  reason: string;
  /** ผู้ถือครองที่ตั้งใจไว้ — ของที่ปิดถาวรก็ยังต้องบอกว่าเดิมจะเป็นของใคร คนนั้นจะได้รู้ว่าไม่ได้ */
  ownerName: string;
}

interface BaseNotice {
  requestId: number;
  /** ปลายทาง — ผู้เรียกเป็นคนตัดสินว่ามีผู้รับไหม ไม่ส่งสตริงว่างมาให้ flow เดา */
  toRequester: string;
  requesterName: string;
  poNumber: string;
  vendorName: string;
  registered: RegisteredAssetLine[];
  cancelled: CancelledAssetLine[];
}

/** ปิดงาน — ไม่มีชิ้นไหนค้างที่ผู้ขอแล้ว */
export interface CompleteNotice extends BaseNotice {
  kind: 'COMPLETE';
}

/** ยังไม่จบ — มีชิ้นรอผู้ขอแก้ (ใบยังอยู่ในคิวบัญชี รอแก้เสร็จแล้วออกเลขต่อ) */
export interface RejectedNotice extends BaseNotice {
  kind: 'REJECTED';
  rejected: RejectedAssetLine[];
  /** ทางเข้าไปแก้ในระบบ ผู้ขอต้องกดจากในเมลได้เลย ไม่ใช่ให้ไปหาใบเองในหน้ารายการ */
  editUrl: string;
}

export type RequesterNotice = CompleteNotice | RejectedNotice;

/**
 * แจ้งผลกลับผู้ขอ — เคสไหนก็เข้าตัวนี้ตัวเดียว
 *
 * คืน SendResult ไม่ throw: การแจ้งเตือนล้มต้องไม่ทำให้การปิดงานของบัญชีล้มตาม
 * (ผู้เรียกเก็บผลลง notifiedAt/notifyError แล้วตัดสินเองว่าจะให้ลองใหม่ได้ไหม)
 */
export async function sendToRequester(notice: RequesterNotice): Promise<SendResult> {
  return postToFlow({
    url: requesterFlowUrl(),
    envKey: 'POWER_AUTOMATE_REQUESTER_URL',
    subject: notice.kind === 'COMPLETE' ? 'อีเมลแจ้งผลการออกเลข' : 'อีเมลแจ้งรายการที่ต้องแก้ไข',
    body: {
      kind: notice.kind,
      toRequester: notice.toRequester,
      requestId: notice.requestId,
      requesterName: notice.requesterName,
      poNumber: notice.poNumber,
      vendorName: notice.vendorName,
      registered: notice.registered,
      cancelled: notice.cancelled,
      // สองช่องนี้มีเฉพาะเคส REJECTED — ส่ง null ไม่ใช่ [] เพื่อให้ flow ที่เผลอเช็ค
      // "ว่างไหม" แทนที่จะเช็ค kind พังทันทีแบบเห็น ๆ แทนที่จะส่งเมลผิดแบบเงียบ ๆ
      rejected: notice.kind === 'REJECTED' ? notice.rejected : null,
      editUrl: notice.kind === 'REJECTED' ? notice.editUrl : null,
      emailHtml:
        notice.kind === 'COMPLETE' ? buildCompleteEmailHtml(notice) : buildRejectedEmailHtml(notice),
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// เนื้ออีเมล
// ═══════════════════════════════════════════════════════════════════════════

const TH = 'padding:8px;border:1px solid #e5e7eb;text-align:left';
const TD = 'padding:8px;border:1px solid #e5e7eb';
const MONO = `${TD};font-family:monospace`;
const TABLE = 'border-collapse:collapse;font-size:14px;width:100%';

/** ปรับ Header ใหม่ตาม Requirement */
function head(n: RequesterNotice): string {
  return `<p style="margin:0 0 4px">เรียนคุณ ${esc(n.requesterName)}</p>
    <p style="margin:0 0 12px">ขอแจ้งรายละเอียดการขึ้นทะเบียนสินทรัพย์</p>
    <p style="margin:0 0 16px;color:#6b7280">
      คำขอ #${n.requestId}<br>PO ${esc(n.poNumber)}<br>${esc(n.vendorName)}
    </p>`;
}

/** ตารางชิ้นที่ได้เลขแล้ว — ใช้ทั้งสองเคส */
function registeredTable(rows: RegisteredAssetLine[]): string {
  if (rows.length === 0) return '';
  const body = rows
    .map(
      (a) => `<tr>
        <td style="${MONO}">${esc(a.assetNumber)}</td>
        <td style="${TD}">${esc(a.description)}</td>
        <td style="${MONO}">${esc(a.serialNumber)}</td>
        <td style="${TD}">${esc(a.location)}</td>
        <td style="${TD}">${esc(a.ownerName)}</td>
      </tr>`,
    )
    .join('');
  return `<h3 style="margin:24px 0 8px">ได้รับเลขทะเบียนแล้ว ${rows.length} รายการ</h3>
    <table style="${TABLE}">
      <thead><tr style="background:#f3f4f6">
        <th style="${TH}">เลขสินทรัพย์</th><th style="${TH}">รายการ</th>
        <th style="${TH}">Serial No.</th><th style="${TH}">สถานที่</th>
        <th style="${TH}">ผู้ถือครอง</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/** ชิ้นที่ถูกปิดถาวร */
function cancelledTable(rows: CancelledAssetLine[]): string {
  if (rows.length === 0) return '';
  const body = rows
    .map(
      (a) => `<tr>
        <td style="${MONO}">${esc(a.unitLabel)}</td>
        <td style="${TD}">${esc(a.description)}</td>
        <td style="${TD}">${esc(a.reason)}</td>
        <td style="${TD}">${esc(a.ownerName)}</td>
      </tr>`,
    )
    .join('');
  return `<h3 style="margin:24px 0 8px">ปิดถาวร ${rows.length} รายการ (ไม่ขึ้นทะเบียน)</h3>
    <table style="${TABLE}">
      <thead><tr style="background:#f3f4f6">
        <th style="${TH}">ชิ้นที่</th><th style="${TH}">รายการ</th><th style="${TH}">เหตุผล</th>
        <th style="${TH}">ผู้ถือครอง</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

function buildCompleteEmailHtml(n: CompleteNotice): string {
  return `<div style="font-family:Segoe UI,Tahoma,sans-serif;color:#111827">
    ${head(n)}
    <h3 style="margin:0 0 8px;color:#15803d">ลงทะเบียนสินทรัพย์เรียบร้อยแล้ว</h3>
    <p style="margin-top: 0; margin-bottom: 16px;">คำขอนี้ดำเนินการครบทุกรายการแล้ว</p>
    ${registeredTable(n.registered)}
    ${cancelledTable(n.cancelled)}
  </div>`;
}

function buildRejectedEmailHtml(n: RejectedNotice): string {
  const rows = n.rejected
    .map(
      (a) => `<tr>
        <td style="${MONO}">${esc(a.unitLabel)}</td>
        <td style="${TD}">${esc(a.description)}</td>
        <td style="${MONO}">${esc(a.serialNumber)}</td>
        <td style="${TD}">${esc(a.reason)}</td>
        <td style="${TD}">${esc(a.ownerName)}</td>
      </tr>`,
    )
    .join('');

  return `<div style="font-family:Segoe UI,Tahoma,sans-serif;color:#111827">
    ${head(n)}
    <h3 style="margin:0 0 8px;color:#b91c1c">*มีรายการที่ต้องแก้ไขก่อนออกเลขสินทรัพย์</h3>
    <div style="border-left:4px solid #d97706;background:#fef3c7;padding:12px 16px;margin:16px 0">
      <strong>ต้องแก้ไข ${n.rejected.length} รายการ</strong>
      <div style="margin-top:6px;font-size:13px">
        แก้ไขในระบบแล้วรายการจะกลับเข้าคิวออกเลขให้อัตโนมัติ ไม่ต้องส่งคำขอใหม่
      </div>
    </div>
    <table style="${TABLE}">
      <thead><tr style="background:#f3f4f6">
        <th style="${TH}">ชิ้นที่</th><th style="${TH}">รายการ</th>
        <th style="${TH}">Serial No.</th><th style="${TH}">เหตุผลที่ตีกลับ</th>
        <th style="${TH}">ผู้ถือครอง</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="margin:20px 0">
      <a href="${esc(n.editUrl)}"
         style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">
        เปิดใบคำขอเพื่อแก้ไข
      </a>
    </p>
    ${registeredTable(n.registered)}
    ${cancelledTable(n.cancelled)}
  </div>`;
}