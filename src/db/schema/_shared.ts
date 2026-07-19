// ของที่ทุกไฟล์ใน schema/ ใช้ร่วมกัน — ห้าม import จากไฟล์ตารางกลับมาที่นี่ (จะเกิด circular)
import { customType } from 'drizzle-orm/pg-core';

// column เป็น `timestamp without time zone` — pg คืน wall-clock string ('YYYY-MM-DD HH:mm:ss.ffffff')
// ถือ wall-clock เป็น UTC แล้ว format เป็น ISO-Z (ตัดเป็น ms) ให้ตรงกับที่ TypeORM เคยส่ง
// ไม่ใช้ mode:'date' เพราะ node-postgres จะตีความเป็น local time ทำให้เวลาเลื่อนตาม timezone เครื่อง
export const isoTimestamp = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'timestamp';
  },
  fromDriver(value) {
    return new Date(`${value.replace(' ', 'T')}Z`).toISOString();
  },
});
