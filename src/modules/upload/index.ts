// ประตูเดียวของ module — ไฟล์อื่นใน module นี้ถือเป็น internal
export { uploadRoutes } from './upload.routes';
// cleanupOrphans ออกมาด้วยเพราะ src/index.ts ต้องตั้งเวลาเรียก (ไม่ได้ผ่าน HTTP)
export { cleanupOrphans } from './upload.service';
