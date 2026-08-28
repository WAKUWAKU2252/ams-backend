// ท่อบาง ๆ: แกะของจาก request -> เรียก service -> ส่งของกลับ
// ห้ามมี logic / ห้าม try-catch (error-handler แปลง AppError ให้เอง) / ห้าม query DB
import { Elysia } from 'elysia';
import {
  assetByNumberQuery,
  assetIdParams,
  assetInventoryQuery,
  assetListQuery,
  createAssetBody,
  updateAssetBody,
} from './asset.schema';
import * as assetService from './asset.service';
import { authGuard } from '@plugins/auth';

export const assetRoutes = new Elysia({ prefix: '/assets' })
  .use(authGuard)
  // หน้าฟอร์มลงทะเบียนเรียกเส้นนี้เส้นเดียวก็เรนเดอร์ได้ทั้งหน้า (ช่อง + สถานะ + รอบรับของ)
  .get('/', ({ query }) => assetService.findSlotsByRequest(query.requestId), {
    query: assetListQuery,
  })
  // ★ ต้องมาก่อน '/:id' — ถ้าอยู่ทีหลัง 'mine' จะถูกจับเป็น id แล้วตกด่าน t.Numeric()
  //   กลายเป็น 422 ทั้งที่เส้นทางมีอยู่จริง (Elysia ให้ static ชนะ param อยู่แล้ว แต่
  //   ลำดับที่อ่านแล้วเห็นเองปลอดภัยกว่าการพึ่งพฤติกรรมของ router)
  //
  // ไม่มี requireRole — ทุกคนดูของตัวเองได้ และ "ตัวเอง" มาจาก token ไม่ได้มาจาก query
  // จึงไม่มีทางที่ใครจะถามหาของคนอื่นผ่านเส้นนี้
  .get('/mine', ({ currentUser }) => assetService.findMine(currentUser.id))
  // ★ ต้องมาก่อน '/:id' ด้วยเหตุผลเดียวกับ '/mine' — 'inventory' จะถูกจับเป็น id แล้วตกด่าน
  //
  // ไม่มี requireRole และไม่ล็อกแผนกตาม role — ทุกคนค้นทะเบียนได้ (ดูเหตุผลที่ findInventory)
  // ต่างจาก /dashboard/overview ที่ล็อกแผนกไว้ เพราะอันนั้นเป็นมูลค่ารวมรายแผนก
  .get('/inventory', ({ query }) => assetService.findInventory(query), {
    query: assetInventoryQuery,
  })
  .get('/:id', ({ params }) => assetService.findOneOrFail(params.id), { params: assetIdParams })
  .post('/', ({ body, currentUser }) => assetService.create(body, currentUser.id), {
    body: createAssetBody,
  })
  .patch('/:id', ({ params, body, currentUser }) => assetService.update(params.id, body, currentUser.id), {
    params: assetIdParams,
    body: updateAssetBody,
  })
  .delete('/:id', ({ params, currentUser }) => assetService.softDelete(params.id, currentUser.id), {
    params: assetIdParams,
  });

/**
 * ปลายทางของ QR บนสติกเกอร์ — **เปิดสาธารณะ ไม่อยู่หลัง authGuard**
 *
 * คนที่สแกนคือคนที่ยืนอยู่หน้าเครื่องจริง ซึ่งอาจไม่มีบัญชีในระบบเลย (ช่างที่มาซ่อม/ผู้รับเหมา)
 * ถ้าบังคับล็อกอินก่อน สติกเกอร์จะใช้ไม่ได้กับคนกลุ่มนั้นทั้งหมด
 *
 * ★ แลกกับการเปิดสาธารณะ: **ตัวเลขเงินขึ้นเฉพาะคนที่ล็อกอินแล้ว** (ดู findByAssetNumber)
 *   URL เดาได้ไม่ยากถ้ารู้รูปแบบเลข ปล่อยราคาทุน/ค่าเสื่อม/มูลค่าคงเหลือให้คนนอกเห็น
 *   = เปิดมูลค่าทรัพย์สินทั้งบริษัทให้ใครก็ได้ไล่ดูทีละชิ้น
 *
 * เลขมาทาง query ไม่ใช่ path เพราะเลขจริงบางตัวมี '/' (MAC-212-13-001/1) ซึ่ง %2F ใน path
 * เจอ router/proxy ที่ decode ก่อน match แล้วแตกเป็นสอง segment → 404 โดยไม่มีอะไรบอก
 */
export const assetPublicRoutes = new Elysia({ prefix: '/assets' })
  .get('/by-number', ({ query }) => assetService.findByAssetNumber(query.number, query.company), {
    query: assetByNumberQuery,
  });
