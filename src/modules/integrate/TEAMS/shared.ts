// ═══════════════════════════════════════════════════════════════════════════
// ของกลางของทุก flow ที่ยิงเข้า Power Automate — ตัวยิง + ชนิดผลลัพธ์ + helper ข้อความ
//
// ★ ไม่มี "URL กลาง" ที่นี่โดยตั้งใจ: แต่ละ flow เป็นคนละ flow บน Power Automate จึงมี
//   URL (พร้อม signature ของตัวเอง) คนละอัน ไฟล์ของแต่ละ flow เป็นคนอ่าน env ของตัวเอง
//   ถ้ารวมเป็นตัวเดียวที่นี่ วันที่เพิ่ม flow ที่สามจะกลายเป็นการแก้ไฟล์กลางทุกครั้ง
//   และที่แย่กว่านั้นคือเผลอส่งใบของ flow หนึ่งไปเข้าอีก flow แล้วมันตอบ 200 กลับมาเฉย ๆ
//
// ไฟล์นี้ห้าม import teams.service (ตัวนั้น import asset-request.service ซึ่งจะ import
// กลับมา = วน) — ที่นี่รู้จักแค่ "จะส่งอะไรออกไป" ไม่รู้จักใบคำขอ
// ═══════════════════════════════════════════════════════════════════════════

export interface SendResult {
  ok: boolean;
  /** HTTP status ที่เหมาะกับผลนี้ — route เอาไปเซ็ตต่อ ไม่ต้องตีความเอง */
  status: number;
  message: string;
  error?: string;
}

/** หนี HTML ก่อนยัดค่าที่คนกรอกลงเทมเพลตอีเมล — ชื่อของ/เหตุผลมี < & " ได้จริง */
export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** ISO -> "18/8/2569 13:45" เวลาไทย — การ์ดกับอีเมลมีคนอ่าน ไม่ใช่ระบบอ่าน */
export function thaiDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // ระบุ option เอง ไม่ใช้ dateStyle: 'short' — อันนั้นให้ปีสองหลัก ("17/8/69") ซึ่งอ่านกำกวม
  // ว่าเป็น ค.ศ. หรือ พ.ศ. ในเอกสารที่ต้องอ้างย้อนหลัง
  return d.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface PostOptions {
  /** URL ของ flow นั้น ๆ (ว่าง = ยังไม่ได้ตั้งค่า) */
  url: string;
  /** ชื่อ env ที่ถือ URL นี้ — ใส่ในข้อความ 503 ให้คนแก้รู้ว่าต้องไปตั้งตัวไหน */
  envKey: string;
  /** สิ่งที่กำลังส่ง เช่น 'การ์ดขออนุมัติ' — ใช้ประกอบข้อความให้ตรงกับงานจริง */
  subject: string;
  body: unknown;
}

/**
 * ยิงเข้า flow หนึ่ง แล้วคืนผลเป็น object ไม่ throw
 *
 * ผู้เรียกมีสองแบบที่ต้องการคนละอย่าง: route ต้องการ status ไปเซ็ตต่อ ส่วน service ต้องการ
 * แค่ "สำเร็จไหม/ข้อความว่าอะไร" ไปเก็บลง notifiedAt/notifyError — และห้ามให้การแจ้งเตือน
 * ล้มไปทำให้ธุรกรรมหลัก (ส่งใบ/ปิดงาน) ล้มตาม
 */
export async function postToFlow({ url, envKey, subject, body }: PostOptions): Promise<SendResult> {
  if (!url) {
    return {
      ok: false,
      status: 503,
      message: `ยังไม่ได้ตั้งค่าการเชื่อมต่อ Teams สำหรับ${subject} (${envKey} ใน .env)`,
    };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      // flow วาง Response ไว้เป็น action แรก จึงตอบกลับทันทีในไม่กี่วินาที
      // ตัวนี้เป็นตาข่ายกันค้างระดับเครือข่ายเท่านั้น ไม่ได้ตั้งไว้รอ flow ทำงาน
      //
      // 150 วิ ไม่ใช่ตัวเลขมั่ว — Power Automate ตัดที่ 120 วิเองอยู่แล้ว (ตอบ 504 กลับมา
      // ซึ่ง handle ได้ปกติ) ตั้งสูงกว่านั้นเพื่อให้ error ของฝั่งเขาถึงเราก่อน
      // ตั้งต่ำกว่า 120 ไม่ได้: ถ้าวันหลังมีใครย้าย Response ไปไว้ท้าย flow เราจะตัดสาย
      // ที่ยังทำงานอยู่แล้วรายงานว่าล้มทั้งที่ส่งไปแล้ว ซึ่งแย่กว่ารอนาน
      signal: AbortSignal.timeout(150_000),
    });

    if (response.ok) return { ok: true, status: 200, message: `ส่ง${subject}เรียบร้อยแล้ว` };

    const responseText = await response.text();
    console.error(`❌ Power Automate Error (${envKey}):`, responseText);
    return {
      ok: false,
      status: response.status,
      message: `ส่ง${subject}ไม่สำเร็จ`,
      error: responseText,
    };
  } catch (error) {
    // หมดเวลา = ยิงออกไปแล้วแต่ไม่รู้ผล ต่างจากต่อไม่ติดที่รู้แน่ว่าไม่ถึง
    // ต้องแยกข้อความ ไม่งั้นผู้ใช้จะไปตามซ้ำทั้งที่ของอาจส่งไปแล้ว
    if (error instanceof Error && error.name === 'TimeoutError') {
      return {
        ok: false,
        status: 504,
        message: `Teams ไม่ตอบกลับในเวลาที่กำหนด — ตรวจสอบว่า${subject}ออกไปแล้วหรือยังก่อนส่งซ้ำ`,
      };
    }
    console.error('❌ เกิดข้อผิดพลาดขณะเชื่อมต่อ Teams:', error);
    return { ok: false, status: 500, message: 'เกิดข้อผิดพลาดขณะเชื่อมต่อ Teams' };
  }
}
