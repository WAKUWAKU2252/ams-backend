// ประตูเดียวของ module — ไฟล์อื่นใน module นี้ถือเป็น internal
export { uploadRoutes, uploadPublicRoutes } from './upload.routes';
// scheduler ออกมาด้วยเพราะ src/index.ts เป็นคนสั่งเริ่ม (ไม่ได้ผ่าน HTTP)
// ไม่ export cleanupOrphans แล้ว — ตัวเรียกเดียวคือ scheduler ซึ่งอยู่ใน module นี้เอง
export { startUploadCleanupScheduler, stopUploadCleanupScheduler } from './upload.scheduler';
