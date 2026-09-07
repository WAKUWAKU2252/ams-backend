// ═══ ไฟล์แนบสติกเกอร์ QR ที่ติดไปกับอีเมลแจ้งผลการออกเลข ═══
//
// ★ เทสต์เรียก buildLabelAttachments ตรง ๆ ไม่ผ่าน sendToRequester — เพราะ test/setup.ts
//   stub ทั้งโมดูล sendToRequester ทิ้ง (ด่านกันชุดเทสต์ยิงเข้า Power Automate ของบริษัทจริง)
//   ถ้า import อะไรจากไฟล์นั้นจะได้ stub แล้วเทสต์จะ "ผ่าน" โดยไม่ได้แตะโค้ดจริงสักบรรทัด
//   ตัวสร้างไฟล์แนบจึงต้องอยู่คนละไฟล์กับตัวที่ถูก mock
import { describe, expect, test } from 'bun:test';
import { buildLabelAttachments } from '@modules/integrate/TEAMS/assetLabelAttachment';
import { buildAssetLabelPdf } from '@common/asset-label-pdf';

const REQUEST_ID = 42;
const line = (assetNumber: string, qrCode: string | null) => ({ assetNumber, qrCode });

/** นับหน้าใน PDF — /Type /Page ที่ไม่ใช่ /Type /Pages */
const pageCount = (pdf: string) => [...pdf.matchAll(/\/Type \/Page[^s]/g)].length;
const asPdf = (contentBytes: string) => Buffer.from(contentBytes, 'base64');

describe('ไฟล์แนบของอีเมลแจ้งผลการออกเลข', () => {
  test('มีชิ้นที่มี qrCode → ได้ PDF หนึ่งไฟล์ ชื่ออิงเลขใบคำขอ', async () => {
    const out = await buildLabelAttachments(REQUEST_ID, [
      line('COM-100-05-002', 'http://host/assets/UBA/COM-100-05-002'),
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]!.Name).toBe('asset-labels-42.pdf');

    // ต้องเป็น PDF จริง ไม่ใช่สตริงอะไรก็ได้ที่ base64 ได้
    const bytes = asPdf(out[0]!.ContentBytes);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.subarray(-8).toString()).toContain('%%EOF');
  });

  test('หลายชิ้น → ไฟล์เดียวหลายหน้า หน้าละชิ้น', async () => {
    const out = await buildLabelAttachments(REQUEST_ID, [
      line('A-001', 'http://host/assets/UBA/A-001'),
      line('A-002', 'http://host/assets/UBA/A-002'),
      line('A-003', 'http://host/assets/UBA/A-003'),
    ]);

    const pdf = asPdf(out[0]!.ContentBytes).toString('latin1');
    expect(pageCount(pdf)).toBe(3);
    expect(pdf).toContain('/Count 3');
  });

  test('ชิ้นที่ไม่มี qrCode ถูกข้าม ไม่ใช่พิมพ์ QR เปล่า', async () => {
    const out = await buildLabelAttachments(REQUEST_ID, [
      line('A-001', 'http://host/assets/UBA/A-001'),
      line('A-002', null),
    ]);

    const pdf = asPdf(out[0]!.ContentBytes).toString('latin1');
    expect(pageCount(pdf)).toBe(1);
    expect(pdf).toContain('(A-001)');
    expect(pdf).not.toContain('(A-002)');
  });

  test('ไม่มีชิ้นไหนมี qrCode เลย → [] ไม่ใช่ null และไม่โยน', async () => {
    // flow เอาค่านี้ไป map ลงช่อง Attachments ของ Send an email (V2) ตรง ๆ
    // ซึ่งรับ array ว่างได้ แต่ null ทำให้ action นั้นล้มทั้ง flow
    expect(await buildLabelAttachments(REQUEST_ID, [line('A-001', null)])).toEqual([]);
  });

  test('ไม่มีชิ้นที่ออกเลขเลย (ตีกลับ/ปิดถาวรหมดทั้งใบ) → []', async () => {
    expect(await buildLabelAttachments(REQUEST_ID, [])).toEqual([]);
  });
});

describe('ขนาดกระดาษของสติกเกอร์', () => {
  test('MediaBox = 60 x 20 mm พอดี', async () => {
    const pdf = Buffer.from(
      await buildAssetLabelPdf([{ assetNumber: 'A-001', qrCode: 'http://host/a' }]),
    ).toString('latin1');

    // 60mm = 170.08pt, 20mm = 56.69pt — เลขคู่นี้คือสิ่งที่ทำให้พิมพ์ออกมาตรงแม่พิมพ์
    expect(pdf).toContain('/MediaBox [0 0 170.08 56.69]');
  });

  test('วงเล็บในเลขสินทรัพย์ถูก escape — ไม่งั้นไฟล์เสียทั้งใบ', async () => {
    const pdf = Buffer.from(
      await buildAssetLabelPdf([{ assetNumber: 'LXM X215MFP (Printer)', qrCode: 'http://host/a' }]),
    ).toString('latin1');

    expect(pdf).toContain('(LXM X215MFP \\(Printer\\)) Tj');
  });

  test('เลขที่เป็นภาษาไทย → มี QR แต่ไม่มีข้อความ (Helvetica เขียนไทยไม่ได้)', async () => {
    const pdf = Buffer.from(
      await buildAssetLabelPdf([{ assetNumber: 'เครื่องพิมพ์', qrCode: 'http://host/a' }]),
    ).toString('latin1');

    expect(pdf).not.toContain(' Tj');
    // แต่ QR ยังต้องถูกวาด — สแกนได้เหมือนเดิม
    expect(pdf).toContain(' re');
  });
});
