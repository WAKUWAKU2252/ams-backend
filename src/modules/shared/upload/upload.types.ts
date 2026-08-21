// สัญญาชนิดข้อมูลของโมดูล upload
import type { attachment } from '@intrastucture/db/schema';

export type AttachmentRow = typeof attachment.$inferSelect;

/** ประเภทเอกสารที่ระบบรับ — ต้องตรงกับคีย์ของ RULES ใน upload.service.ts */
export type DocType = AttachmentRow['docType'];

/**
 * กติกาต่อประเภทเอกสาร
 * ext ทำสองหน้าที่: เป็น whitelist (MIME นอก map = ปฏิเสธ) และเป็นตัวกำหนด
 * นามสกุลบน disk — derive จาก MIME ไม่ตัดจากชื่อไฟล์ผู้ใช้ เพื่อกัน path traversal
 */
export interface UploadRule {
  ext: Readonly<Record<string, string>>;
  maxSize: number;
}

/** ไฟล์ที่บันทึกสำเร็จ — รูปนี้ frontend อ่านตรง ๆ ห้ามเปลี่ยนชื่อฟิลด์ */
export interface SavedFile {
  id: string;
  name: string;
  url: string;
  size: number;
}

export interface SaveFilesResult {
  files: SavedFile[];
}

/** ตำแหน่งไฟล์บน disk + metadata ที่ route ใช้ตั้ง header ตอนส่งไฟล์กลับ */
export interface StoredFileRef {
  path: string;
  mimeType: string;
  originalName: string;
}

export interface DeleteAttachmentResult {
  success: true;
}
