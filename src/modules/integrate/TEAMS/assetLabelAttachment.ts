// ═══════════════════════════════════════════════════════════════════════════
// แปลง "ชิ้นที่เพิ่งได้เลข" เป็นไฟล์แนบสติกเกอร์ของอีเมลแจ้งผล
//
// ── ทำไมแยกไฟล์จาก sendToRequester.ts ─────────────────────────────────────
//
// test/setup.ts mock ทั้งโมดูล sendToRequester ทิ้ง (ด่านกันชุดเทสต์ยิงเข้า Power Automate
// ของบริษัทจริง) — อะไรที่อยู่ในไฟล์นั้นจึงเทสต์ไม่ได้เลย ต่อให้ export ออกมาก็ได้ stub
// กลับไป ตรรกะที่ต้องมีเทสต์เฝ้าจึงต้องอยู่นอกไฟล์ที่ถูก mock
//
// (ไฟล์นี้ไม่ยิงเน็ตเอง มันแค่ประกอบ bytes — ตัวที่ยิงคือ postToFlow ใน sendToRequester)
// ═══════════════════════════════════════════════════════════════════════════
import { assetLabelFileName, buildAssetLabelPdf } from '@common/asset-label-pdf';

/** รูปแบบที่ Send an email (V2) ของ Power Automate ต้องการเป๊ะ ๆ (ชื่อช่องขึ้นต้นตัวใหญ่) */
export interface FlowAttachment {
  Name: string;
  /** เนื้อไฟล์ base64 — Power Automate เรียกช่องนี้ว่า ContentBytes */
  ContentBytes: string;
}

/** รูปย่อที่สุดที่ตัวนี้ต้องใช้ — ไม่ผูกกับ RegisteredAssetLine ทั้งก้อน */
export interface LabelSource {
  assetNumber: string;
  /** ค่าจาก asset.qrCode — null = ทะเบียนยังไม่มี URL ให้ชิ้นนี้ */
  qrCode: string | null;
}

/**
 * ทำ PDF สติกเกอร์ของทั้งใบ (หน้าละชิ้น) แล้วแปลงเป็น base64
 *
 * ★ ล้มแล้วต้องไม่ลากเมลตาย — คืน [] แทนการโยน: ผู้ขอควรได้เมลแจ้งผลเสมอ ส่วนสติกเกอร์
 *   เป็นของแถมที่ขอใหม่ทีหลังได้ (การปิดใบของบัญชีเสร็จไปแล้วตั้งแต่ก่อนถึงตรงนี้)
 *
 * ★ ข้ามชิ้นที่ยังไม่มี qrCode แทนที่จะพิมพ์ QR เปล่า — สติกเกอร์ที่สแกนแล้วไม่ไปไหน
 *   แย่กว่าไม่มีสติกเกอร์ เพราะคนแปะไปแล้วจะเข้าใจว่าของชิ้นนั้นมีทะเบียนเรียบร้อย
 *
 * ★ คืน [] ไม่ใช่ null เสมอ — flow เอาไป map ลงช่อง Attachments ของ Send an email (V2)
 *   ตรง ๆ ซึ่งรับ array ว่างได้ แต่ null ทำให้ action นั้นล้มทั้ง flow
 */
export async function buildLabelAttachments(
  requestId: number,
  registered: LabelSource[],
): Promise<FlowAttachment[]> {
  const labels = registered
    .filter((r): r is LabelSource & { qrCode: string } => !!r.qrCode)
    .map((r) => ({ assetNumber: r.assetNumber, qrCode: r.qrCode }));

  if (!labels.length) return [];

  try {
    const pdf = await buildAssetLabelPdf(labels);
    return [
      { Name: assetLabelFileName(requestId), ContentBytes: Buffer.from(pdf).toString('base64') },
    ];
  } catch (e) {
    console.error(`⚠️ สร้างไฟล์สติกเกอร์ของคำขอ ${requestId} ไม่สำเร็จ:`, e);
    return [];
  }
}
