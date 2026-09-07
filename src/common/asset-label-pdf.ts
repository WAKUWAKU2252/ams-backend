// ═══════════════════════════════════════════════════════════════════════════
// สติกเกอร์ติดตัวเครื่อง: QR | เลขสินทรัพย์ — สร้างเป็น PDF หน้าละชิ้น
//
// แนบไปกับอีเมลแจ้งผลการออกเลข (ดู sendToRequester.ts) ผู้ขอสั่งพิมพ์เข้าเครื่องพิมพ์
// สติกเกอร์ได้ทันทีโดยไม่ต้องเปิดระบบ
//
// ── ทำไมเป็น PDF ไม่ใช่ PNG ────────────────────────────────────────────────
//
// PDF มี "ขนาดจริง" อยู่ในตัว (MediaBox เป็นหน่วย point) เครื่องพิมพ์จึงออกมาเป็น
// 20×60 mm เป๊ะทุกเครื่อง ส่วน PNG เป็นแค่ตารางพิกเซล ขนาดที่พิมพ์ออกมาขึ้นกับ DPI
// ที่ driver เดาเอง — สติกเกอร์ที่ออกมาเล็ก/ใหญ่ไม่ตรงแม่พิมพ์คือของเสียทั้งม้วน
//
// ── ทำไมเขียน PDF เอง ไม่ใช้ library ───────────────────────────────────────
//
// ของที่ต้องวาดมีแค่สองอย่าง: สี่เหลี่ยมดำ (QR) กับข้อความบรรทัดเดียว ซึ่ง PDF ทำได้
// ด้วย operator `re f` กับ `Tj` และฟอนต์ Helvetica เป็นหนึ่งใน 14 ฟอนต์มาตรฐานที่
// reader ทุกตัวมีอยู่แล้ว ไม่ต้องฝังไฟล์ฟอนต์ — ผลคือไฟล์ ~3 KB ต่อสิบชิ้น และไม่ต้อง
// แบก dependency ที่ต้องคอยอัปเดตตามช่องโหว่
// ═══════════════════════════════════════════════════════════════════════════
import QRCode from 'qrcode';

/** 1 mm = กี่ point (PDF ใช้ point เป็นหน่วยเดียว: 72 point = 1 inch = 25.4 mm) */
const MM = 72 / 25.4;

const LABEL_W_MM = 60;
const LABEL_H_MM = 20;
/** เว้นขอบรอบสติกเกอร์ — เครื่องพิมพ์ป้อนกระดาษเบี้ยวได้เล็กน้อย อย่าวาดชิดขอบ */
const PAD_MM = 1;

/**
 * ระดับการกู้คืนของ QR — ต้องเป็น 'M' เท่ากับที่หน้าจอวาด (AppAssetDetail / AssetRequestForm)
 *
 * ★ ห้ามเปลี่ยนเฉพาะที่นี่: QR ของชิ้นเดียวกันที่วาดจากคนละที่จะหน้าตาไม่เหมือนกัน
 *   ซึ่งทำให้เทียบด้วยตาไม่ได้เวลาสงสัยว่าสติกเกอร์ที่แปะอยู่ตรงกับในระบบไหม
 */
const ECC = 'M' as const;

/** ชิ้นหนึ่งที่จะพิมพ์ */
export interface AssetLabel {
  /** ข้อความใต้/ข้าง QR — เลขสินทรัพย์ */
  assetNumber: string;
  /**
   * URL ที่จะฝังใน QR — **ต้องเป็นค่าจาก asset.qrCode เท่านั้น**
   *
   * ★ ห้ามประกอบใหม่จาก assetNumber ที่นี่: ค่าที่เก็บไว้คือค่าที่ตรงกับสติกเกอร์ที่พิมพ์
   *   ไปแล้ว ถ้าประกอบเองแล้ววันหลัง APP_BASE_URL เปลี่ยน สติกเกอร์ล็อตใหม่จะชี้คนละที่
   *   กับล็อตเก่าโดยไม่มีอะไรฟ้อง (กติกาเดียวกับที่ asset.types.ts เขียนไว้)
   */
  qrCode: string;
}

/**
 * escape ข้อความให้อยู่ในวงเล็บของ PDF string ได้
 *
 * `\` `(` `)` มีความหมายพิเศษใน syntax ของ PDF — ไม่ escape แล้วไฟล์เสียทั้งใบ
 * (เลขสินทรัพย์จริงมีวงเล็บอยู่ เช่น "LXM X215MFP (Printer & FAX)")
 */
const escapePdfText = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/**
 * Helvetica เขียนได้เฉพาะอักขระใน WinAnsi (Latin-1) — ไทยไม่ได้
 *
 * ★ เจอตัวนอกช่วงแล้ว "ไม่พิมพ์ข้อความ" ดีกว่าพิมพ์เป็นขยะ: ทะเบียนจริงมีเลขที่เป็น
 *   ชื่อสินค้าภาษาไทยอยู่ 1 ชิ้น ถ้าปล่อยผ่านจะได้สติกเกอร์ที่มีตัวอักษรมั่ว ๆ ซึ่งคนอ่าน
 *   แล้วเข้าใจว่าระบบพัง — QR ยังสแกนได้ตามปกติ (QR เก็บ URL ไม่ได้เก็บข้อความนี้)
 *   ถ้าวันหลังต้องพิมพ์ไทยจริง ต้องฝังฟอนต์ไทยเข้าไฟล์ ซึ่งทำให้ไฟล์ใหญ่ขึ้นหลายร้อย KB
 */
const isPrintableLatin1 = (s: string) => /^[\x20-\x7e\xa0-\xff]*$/.test(s);

/**
 * หาขนาดฟอนต์ที่ใหญ่ที่สุดที่ยังไม่ล้นกรอบ
 *
 * ประมาณความกว้างที่ 0.55 em ต่อตัวอักษร ซึ่งเป็นค่าเฉลี่ยของ Helvetica สำหรับตัวพิมพ์
 * ใหญ่กับตัวเลข (เลขสินทรัพย์เป็นสองอย่างนี้เกือบทั้งหมด) — ไม่ต้องแม่นระดับ metric
 * จริงเพราะเราแค่ต้องการ "ไม่ล้น" ไม่ได้จัดหน้าหนังสือ
 */
function fitFontSize(text: string, maxWidthPt: number, maxSizePt: number): number {
  if (!text.length) return maxSizePt;
  const size = maxWidthPt / (text.length * 0.55);
  // ไม่เล็กกว่า 4pt — เล็กกว่านั้นพิมพ์ออกมาก็อ่านไม่ออกอยู่ดี ปล่อยให้ล้นแล้วเห็นปัญหา
  return Math.max(4, Math.min(maxSizePt, size));
}

/**
 * วาด QR หนึ่งอันเป็นสี่เหลี่ยมดำ ๆ ลง content stream
 *
 * ★ ต้องเผื่อ quiet zone 4 โมดูลรอบด้านตามสเปก QR — ไม่เผื่อแล้วกล้องจับขอบไม่เจอ
 *   ในสภาพแสงไม่ดี ซึ่งคือสภาพจริงของการเดินตรวจในโรงงาน จึงหารด้วย (size + 8)
 *   ไม่ใช่ size
 *
 * ★ แกน y ของ PDF ชี้ขึ้น ส่วนแถวของ QR ไล่จากบนลงล่าง — ต้องกลับด้าน ไม่งั้นได้ QR
 *   ที่พลิกแนวนอน ซึ่งสแกนไม่ติดและดูด้วยตาแทบไม่ออก
 */
function qrOps(matrix: { size: number; get(row: number, col: number): boolean }, boxPt: number, originX: number, originY: number): string {
  const total = matrix.size + 8;
  const cell = boxPt / total;
  const ops: string[] = [];

  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (!matrix.get(row, col)) continue;
      const x = originX + (col + 4) * cell;
      const y = originY + boxPt - (row + 4 + 1) * cell;
      // +0.02 กันเส้นขาวบาง ๆ ระหว่างช่องตอน rasterize (rounding ของ renderer)
      ops.push(`${x.toFixed(3)} ${y.toFixed(3)} ${(cell + 0.02).toFixed(3)} ${(cell + 0.02).toFixed(3)} re`);
    }
  }
  // เติมทีเดียวแล้ว fill ครั้งเดียว — เร็วกว่าและไฟล์เล็กกว่า f ทีละช่อง
  return ops.length ? `0 0 0 rg\n${ops.join('\n')}\nf\n` : '';
}

/** content stream ของสติกเกอร์หนึ่งใบ */
function pageContent(label: AssetLabel, matrix: { size: number; get(r: number, c: number): boolean }): string {
  const w = LABEL_W_MM * MM;
  const h = LABEL_H_MM * MM;
  const pad = PAD_MM * MM;

  // QR เป็นจัตุรัส กินความสูงทั้งใบ (หักขอบ) แล้วชิดซ้าย — รูปแบบ "QR | เลข"
  const qrBox = h - pad * 2;
  let content = qrOps(matrix, qrBox, pad, pad);

  if (isPrintableLatin1(label.assetNumber)) {
    const textX = pad + qrBox + pad;
    const textMax = w - textX - pad;
    const size = fitFontSize(label.assetNumber, textMax, 14);
    // จัดกึ่งกลางแนวตั้ง: baseline อยู่ต่ำกว่ากึ่งกลางราว 0.35 em (ครึ่งของความสูงตัวอักษร)
    const baseline = h / 2 - size * 0.35;
    content +=
      `BT\n/F1 ${size.toFixed(2)} Tf\n0 0 0 rg\n` +
      `${textX.toFixed(3)} ${baseline.toFixed(3)} Td\n` +
      `(${escapePdfText(label.assetNumber)}) Tj\nET\n`;
  }

  return content;
}

/**
 * สร้าง PDF หลายหน้า หน้าละหนึ่งสติกเกอร์ — คืนเป็น bytes
 *
 * หน้าละชิ้นเพราะเครื่องพิมพ์สติกเกอร์ป้อนทีละดวงอยู่แล้ว สั่งพิมพ์ครั้งเดียวได้ทั้งใบคำขอ
 *
 * ★ ประกอบไฟล์เองทั้งหมดจึงต้องคุม byte offset ของทุก object ให้ตรงกับตาราง xref
 *   เป๊ะ — คลาดไปไบต์เดียว reader บางตัวเปิดไม่ได้ จึงวัดด้วย Buffer.byteLength('latin1')
 *   ไม่ใช่ .length ของ string (ซึ่งนับเป็นตัวอักษร ไม่ใช่ไบต์)
 */
export async function buildAssetLabelPdf(labels: AssetLabel[]): Promise<Uint8Array> {
  if (!labels.length) throw new Error('buildAssetLabelPdf: ไม่มีรายการให้พิมพ์');

  const matrices = await Promise.all(
    labels.map(async (l) => {
      const qr = QRCode.create(l.qrCode, { errorCorrectionLevel: ECC });
      return qr.modules as unknown as { size: number; get(r: number, c: number): boolean };
    }),
  );

  const w = (LABEL_W_MM * MM).toFixed(2);
  const h = (LABEL_H_MM * MM).toFixed(2);

  // ── ลำดับ object: 1 = Catalog, 2 = Pages, 3 = Font, จากนั้นสลับ Page/Contents ต่อใบ
  const objects: string[] = [];
  const pageIds: number[] = [];
  const FIRST_PAGE_OBJ = 4;

  labels.forEach((_, i) => pageIds.push(FIRST_PAGE_OBJ + i * 2));

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${labels.length} >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;

  labels.forEach((label, i) => {
    const pageId = pageIds[i]!;
    const contentId = pageId + 1;
    const stream = pageContent(label, matrices[i]!);

    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
    objects[contentId] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`;
  });

  // ── ประกอบไฟล์พร้อมเก็บ offset ของแต่ละ object
  const maxId = objects.length - 1;
  const offsets: number[] = [];
  let pdf = '%PDF-1.4\n';

  for (let id = 1; id <= maxId; id++) {
    offsets[id] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxId; id++) {
    pdf += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/** ชื่อไฟล์แนบของใบคำขอหนึ่ง — ผู้ขอเห็นในเมลแล้วรู้ว่าของใบไหน */
export const assetLabelFileName = (requestId: number) => `asset-labels-${requestId}.pdf`;
