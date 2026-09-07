// ท่อบาง ๆ: แกะของจาก request -> เรียก service -> ส่งของกลับ
// ห้ามมี logic / ห้าม try-catch (error-handler แปลง AppError ให้เอง) / ห้าม query DB
import { Elysia } from 'elysia';
import {
  assetByNumberQuery,
  assetIdParams,
  assetInventoryQuery,
  assetListQuery,
  assetResolveNumberQuery,
  createAssetBody,
  roomAssetsParams,
  roomAssetsQuery,
  updateAssetBody,
  updateAssetImageBody,
  updateAssetLocationBody,
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
  // ของที่ตั้งอยู่ในห้องหนึ่ง — หน้าแผนผังใช้ (0024)
  // path ขึ้นต้นด้วยส่วนคงที่ 'by-room' จึงไม่ชนกับ /:id ที่รับเลข
  .get(
    '/by-room/:subLocationId',
    ({ params, query }) => assetService.findByRoom(params.subLocationId, query),
    { params: roomAssetsParams, query: roomAssetsQuery },
  )
  .get('/:id', ({ params }) => assetService.findOneOrFail(params.id), { params: assetIdParams })
  .post('/', ({ body, currentUser }) => assetService.create(body, currentUser.id), {
    body: createAssetBody,
  })
  .patch('/:id', ({ params, body, currentUser }) => assetService.update(params.id, body, currentUser.id), {
    params: assetIdParams,
    body: updateAssetBody,
  })
  // ย้ายที่ตั้งบนผังของชิ้นที่ลงทะเบียนแล้ว — เส้นเดียวที่ REGISTERED แก้ได้ (ดู updateLocation)
  //
  // ★ ต้องแยกเส้น ไม่ใช่ผ่อนด่านใน PATCH /:id — สามช่องนี้ AMS เป็นเจ้าของฝ่ายเดียว
  //   ส่วนช่องอื่นยังเป็นของ SAP และต้อง "แก้ที่ SAP" เหมือนเดิม การรวมสองกติกาไว้ในเส้น
  //   เดียวแปลว่าใครแก้ด่านนั้นทีหลังจะเผลอปลดล็อกช่องที่ SAP ทับกลับมาทุกรอบ sync
  //
  // ไม่มี requireRole — ตรงกับ PATCH /:id ที่อยู่หลัง authGuard เฉย ๆ เหมือนกัน
  // (คนที่ตามหาเครื่องเจอว่ามันถูกย้ายห้อง มักไม่ใช่คนแผนกเดียวกับที่ของสังกัดอยู่ —
  //  เหตุผลเดียวกับที่ GET /assets/inventory เปิดให้ทุก role)
  .patch(
    '/:id/location',
    ({ params, body, currentUser }) => assetService.updateLocation(params.id, body, currentUser.id),
    { params: assetIdParams, body: updateAssetLocationBody },
  )
  // เปลี่ยนรูปของชิ้นที่ลงทะเบียนแล้ว — เหตุผลชุดเดียวกับ /:id/location ข้างบน
  // (imageId ไม่อยู่ใน set: ของ SAP connector = AMS เป็นเจ้าของ sync ไม่เคยทับ)
  .patch(
    '/:id/image',
    ({ params, body, currentUser }) => assetService.updateImage(params.id, body, currentUser.id),
    { params: assetIdParams, body: updateAssetImageBody },
  )
  .delete('/:id', ({ params, currentUser }) => assetService.softDelete(params.id, currentUser.id), {
    params: assetIdParams,
  });

/**
 * ปลายทางของ QR บนสติกเกอร์ — **เปิดสาธารณะ ไม่อยู่หลัง authGuard**
 *
 * คนที่สแกนคือคนที่ยืนอยู่หน้าเครื่องจริง ซึ่งอาจไม่มีบัญชีในระบบเลย (ช่างที่มาซ่อม/ผู้รับเหมา)
 * ถ้าบังคับล็อกอินก่อน สติกเกอร์จะใช้ไม่ได้กับคนกลุ่มนั้นทั้งหมด
 *
 * ★ **ตัวเลขเงินเปิดให้เห็นด้วย ไม่ได้ซ่อนจากคนที่ไม่ได้ล็อกอิน** — ตัดสินใจไว้แบบนั้น
 *   (คอมเมนต์เดิมตรงนี้เขียนว่าซ่อน ซึ่งไม่ตรงกับโค้ด: findByAssetNumber ไม่รับพารามิเตอร์
 *   ผู้ใช้เลยและคืน acquisitionCost/accounting เสมอ — แก้ข้อความให้ตรงกับของจริง)
 *   เหตุผล: หน้านี้ "อ่านอย่างเดียว" แก้อะไรไม่ได้ และคนที่ยืนอยู่หน้าเครื่องจริงเห็นตัวเครื่อง
 *   อยู่แล้ว ถ้าวันไหนตัดสินใจใหม่ ต้องส่ง currentUser เข้า service แล้วตัดฟิลด์ที่นั่น
 *   ไม่ใช่ซ่อนที่หน้าจอ (เส้น API ยังเปิดอยู่)
 *
 * เลขมาทาง query ไม่ใช่ path เพราะเลขจริงบางตัวมี '/' (MAC-212-13-001/1) ซึ่ง %2F ใน path
 * เจอ router/proxy ที่ decode ก่อน match แล้วแตกเป็นสอง segment → 404 โดยไม่มีอะไรบอก
 */
export const assetPublicRoutes = new Elysia({ prefix: '/assets' })
  .get('/by-number', ({ query }) => assetService.findByAssetNumber(query.number, query.company), {
    query: assetByNumberQuery,
  })
  // กู้ QR รูปแบบเก่าที่ไม่มีรหัสบริษัทใน URL — คืนแค่ "เลขนี้เป็นของบริษัทไหนบ้าง"
  // ต้องอยู่ในชุดสาธารณะเหมือน by-number: คนที่สแกนสติกเกอร์เก่ายังไม่ได้ล็อกอินเหมือนกัน
  .get('/resolve-number', ({ query }) => assetService.resolveAssetNumber(query.number), {
    query: assetResolveNumberQuery,
  });
