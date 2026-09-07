import { t } from 'elysia';
import { Value } from '@sinclair/typebox/value';

// สัญญาของแอป: ต้องมี env ครบตามนี้ ไม่ครบ = ไม่ยอมสตาร์ท (fail fast)
const EnvSchema = t.Object({
  PORT: t.Number({ default: 3000 }),
  DB_HOST: t.String(),
  DB_PORT: t.Number(),
  DB_USERNAME: t.String(),
  DB_PASSWORD: t.String(),
  DB_NAME: t.String(),
  DB_SSL: t.Boolean({ default: false }),
  CORS_ORIGIN: t.String({ default: 'http://localhost:5173' }),
  // โดเมนของหน้าเว็บ ใช้ประกอบ URL ที่ฝังใน QR ของสติกเกอร์สินทรัพย์ (ดู common/asset-qr.ts)
  //
  // ⚠️ ต้องตั้งเป็นโดเมนจริงก่อนพิมพ์สติกเกอร์ล็อตแรก — ค่าที่ประกอบแล้วถูกเก็บลง
  // asset.qrCode และพิมพ์ติดบนตัวเครื่อง เปลี่ยนทีหลัง = ต้องไล่พิมพ์ใหม่ทุกชิ้นที่ออกไปแล้ว
  // (แยกจาก CORS_ORIGIN โดยตั้งใจ: อันนั้นคุมว่าใครยิง API ได้ ซึ่งอาจมีหลายที่/เป็น * ได้)
  APP_BASE_URL: t.String({ default: 'http://localhost:5173' }),
  // ⚠️ path สัมพัทธ์ = อิงกับ cwd ตอนรัน — บน production ใช้ absolute path เสมอ
  // และต้องเป็น volume ที่ไม่หายตอน redeploy ไม่งั้น DB จะเหลือทะเบียนที่ชี้ไฟล์ผี
  UPLOAD_DIR: t.String({ default: './uploads' }),
  // กวาดไฟล์กำพร้าทุกกี่นาที (60 = ทุกชั่วโมง) — 0 = ปิด
  // กำพร้า = อัปแล้วแต่ไม่มี asset/grpo ชี้ถึง และเก่ากว่า 24 ชม. (เกณฑ์อยู่ใน service)
  //
  // ★ เพดาน 1440 ด้วยเหตุผลเดียวกับ SAP_SYNC_INTERVAL_MINUTES (ดูคำอธิบาย overflow ที่นั่น)
  //   ตัวนี้อันตรายกว่าเพราะไม่มี cooldown/lock อะไรเลย — overflow เมื่อไหร่คือยิงคิวรี
  //   แล้ววน unlink ไฟล์รัวทุก 1 ms
  UPLOAD_CLEANUP_INTERVAL_MINUTES: t.Number({ default: 60, minimum: 0, maximum: 1440 }),
  JWT_SECRET: t.String({ minLength: 16 }),
  JWT_EXPIRES_IN: t.String({ default: '8h' }),

  // ── Power Automate (แจ้งขออนุมัติเข้า Teams)
  // URL มี signature ต่อท้ายอยู่ในตัว = เป็นความลับเทียบเท่ารหัสผ่าน ห้าม log ห้าม commit
  //
  // default '' แทนที่จะบังคับ: ต่างจาก DB/JWT ที่ขาดแล้วทั้งแอปทำงานไม่ได้ ตัวนี้เป็น
  // integration ตัวเดียว เครื่อง dev ที่ยังไม่ได้ต่อ Teams ต้องสตาร์ทได้ตามปกติ
  // — ฝั่ง route เช็คเองว่าว่างแล้วตอบ 503 พร้อมบอกว่าต้องตั้งค่าอะไร
  POWER_AUTOMATE_URL: t.String({ default: '' }),

  // ── Power Automate flow ที่สอง: แจ้งผลกลับผู้ขอ (อีเมลทางเดียว ไม่มีการ์ด)
  // คนละ flow คนละ URL กับตัวบน — trigger คนละอัน payload คนละหน้าตา ยิงข้ามกันไม่ได้
  // (flow ปลายทางจะตอบ 200 กลับมาเฉย ๆ โดยไม่มีเมลออก ซึ่งหาสาเหตุยากที่สุด)
  //
  // ชื่อ POWER_AUTOMATE_URL ตัวบนไม่เปลี่ยนเป็น ..._MANAGER_URL โดยตั้งใจ — เครื่อง
  // production มี .env ของตัวเอง เปลี่ยนชื่อ = ค่าเดิมไม่ถูกอ่านแล้วการ์ดขออนุมัติเงียบไปทั้งระบบ
  POWER_AUTOMATE_REQUESTER_URL: t.String({ default: '' }),

  // ── ความลับร่วมของ webhook ที่ Power Automate ยิงผลอนุมัติกลับมา (POST /teams/webhook)
  //
  // เส้นนั้นเป็นเส้นเดียวในระบบที่ "เปลี่ยนสถานะใบคำขอ" ได้โดยไม่มี JWT — เพราะ Power
  // Automate ไม่มี token ของเรา ตัวยืนยันตัวตนจึงเหลือแค่ค่านี้ ซึ่งเทียบกับ header
  // X-Teams-Webhook-Secret ที่ flow แนบมา
  //
  // ★ default '' = **ปิดเส้นนั้นทิ้ง** ไม่ใช่ปล่อยผ่าน (ต่างจาก POWER_AUTOMATE_URL ที่ว่าง
  //   แล้วแค่ส่งไม่ได้) ของแบบนี้ต้อง fail closed: ลืมตั้งบน production แล้วปล่อยผ่าน
  //   = ใครก็ได้ยิง curl มาอนุมัติใบแทนหัวหน้า ซึ่งแย่กว่าการที่ flow พังแล้วรู้ตัวทันที
  //
  // ★ ห้าม log ห้าม commit — เทียบเท่ารหัสผ่าน สร้างด้วย `openssl rand -hex 32`
  //   หรือ `bun -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`
  TEAMS_WEBHOOK_SECRET: t.String({ default: '' }),

  // ── SAP B1 (MS SQL Server) — คนละเครื่องกับ ams_db, pool แยกกันคนละตัว
  // login ต้องเป็น read-only ที่ระดับสิทธิ์ DB ไม่ใช่แค่มารยาทในโค้ด:
  // ต่อให้ engine มีบั๊กก็เขียน SAP ไม่ได้ นี่คือกำแพงจริงของ "อ่านอย่างเดียว"
  SAP_DB_HOST: t.String(),
  SAP_DB_PORT: t.Number({ default: 1433 }),
  SAP_DB_NAME: t.String(),
  SAP_DB_USERNAME: t.String(),
  SAP_DB_PASSWORD: t.String(),
  SAP_DB_ENCRYPT: t.Boolean({ default: true }),
  // ยอมรับ self-signed cert (SAP ในวง LAN มักไม่มี cert จริง) — ตั้ง false เมื่อมี cert ที่เชื่อถือได้
  SAP_DB_TRUST_CERT: t.Boolean({ default: true }),
  // อ่านแบบไม่ล็อกตาราง (READ UNCOMMITTED) — SAP เป็น ERP ที่คนทั้งบริษัทใช้อยู่
  // และ UpdateDate มักไม่มี index ทำให้คิวรีเรากวาดทั้งตาราง ถ้าจับ shared lock ไว้นาน
  // คนโพสต์เอกสารจะค้าง; แลกกับความเสี่ยงอ่านแถวที่กำลังแก้แล้วถูก rollback (นาน ๆ ครั้ง
  // และรอบถัดไปทับให้เองเพราะ UpdateDate จะขยับ) — ปรึกษา DBA ก่อนเปลี่ยนเป็น false
  SAP_READ_UNCOMMITTED: t.Boolean({ default: true }),

  // ── ตั้งค่า sync (ปรับได้โดยไม่ต้องแก้โค้ด)
  // กลุ่มสินค้าที่ถือว่าเกี่ยวกับสินทรัพย์ — 117 = fixed asset (ขอบเขตจริงที่ใช้อยู่)
  //
  // 114 (expense) เคยรวมอยู่แล้วถอดออก: 90 วันดึงมา 3,232 บรรทัด ~99% เป็นกาแฟ ทิชชู
  // รองเท้าเซฟตี้ ค่าขนส่ง ค่ากำจัดของเสีย ซึ่งไม่มีทางกลายเป็นสินทรัพย์ ขณะที่ 117 มีแค่
  // 30-40 บรรทัด — และของกลุ่ม 114 ยังนับเป็นเศษ (กก./ตัน) จนทำให้คอลัมน์ quantity พัง
  // ถ้าจะเอา 114 กลับมา ให้ดูก่อนว่า quantity/receivedQty เป็น numeric แล้วหรือยัง
  //
  // ต้องเป็นตัวเลขคั่นจุลภาคเท่านั้น (ค่านี้ถูกต่อลง SQL ตรง ๆ — ดู sap/queries.ts)
  SAP_ITEM_GROUPS: t.String({ default: '117', pattern: '^\\d+(,\\d+)*$' }),
  // backfill ถอยหลังทีละกี่วันต่อรอบ (30 = ประมาณเดือนละก้อน)
  // เพดาน 366: ตั้งกว้างกว่านี้ = ดึงทีเดียวเป็นปี ซึ่งคือสิ่งที่ backfill แบบทยอยตั้งใจเลี่ยง
  SAP_BACKFILL_WINDOW_DAYS: t.Number({ default: 30, minimum: 1, maximum: 366 }),
  // scheduler ยิงทุกกี่นาที (120 = ทุก 2 ชม.) — 0 = ปิด scheduler (ใช้ปุ่มอย่างเดียว)
  //
  // ★ เพดาน 1440 (หนึ่งวัน) ไม่ใช่เรื่องมารยาท แต่กัน setInterval overflow:
  //   ค่าที่เกิน 2^31-1 ms (= 35,791 นาที / ~24.8 วัน) Bun จะ warn แล้ว **clamp เหลือ 1 ms**
  //   ไม่ใช่โยน error — job จึงกลายเป็น tight loop เงียบ ๆ แทนที่จะ "นาน ๆ ทีตามที่ตั้ง"
  //   (ยืนยันบน Bun 1.3.14: TimeoutOverflowWarning แล้วยิงรัวทันที)
  //   ฝั่ง SAP ยังมี cooldown + advisory lock ช่วยดูดซับ แต่ยังกิน connection ของ ams_db
  //   ทุก tick อยู่ดี — ตั้งเพดานให้ config ที่พิมพ์ผิดตกที่ประตูนี้เลย ดีกว่าไปพังตอนรัน
  SAP_SYNC_INTERVAL_MINUTES: t.Number({ default: 120, minimum: 0, maximum: 1440 }),
  // เว้นกี่วินาทีหลังรอบก่อนจบ ถึงจะเริ่มรอบใหม่ได้ — 0 = ปิด
  // advisory lock กันได้แค่ "รันซ้อนกัน" ไม่ได้กัน "กดถี่": รอบที่จบไปเมื่อ 2 วินาทีที่แล้ว
  // แทบไม่มีทางมีของใหม่ให้ดึง กดซ้ำจึงเป็นการรีด ERP ของบริษัทเปล่า ๆ
  // เพดาน 3600 กันตั้งจนสูงเกินไปแล้วปุ่มกลายเป็นกดไม่ได้ทั้งวันโดยไม่มีใครรู้สาเหตุ
  SAP_SYNC_COOLDOWN_SECONDS: t.Number({ default: 30, minimum: 0, maximum: 3600 }),
});

// ค่าใน .env เป็น string ล้วน — Convert แปลงเป็นชนิดจริงตาม schema ("3000" -> 3000)
const parsed = Value.Convert(EnvSchema, Value.Default(EnvSchema, { ...Bun.env }));

if (!Value.Check(EnvSchema, parsed)) {
  const details = [...Value.Errors(EnvSchema, parsed)]
    .map((e) => `  ${e.path.slice(1)}: ${e.message}`)
    .join('\n');
  throw new Error(
    `Environment variables ไม่ครบหรือผิดชนิด:\n${details}\n(เช็คไฟล์ .env เทียบกับ .env.example)`,
  );
}

// จุดเดียวที่แตะ Bun.env — ไฟล์อื่นให้ import { env } จากที่นี่เท่านั้น
export const env: typeof EnvSchema.static = parsed;
