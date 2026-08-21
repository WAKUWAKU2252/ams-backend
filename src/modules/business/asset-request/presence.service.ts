import { createSseStream, type SseEvent } from '@common/sse';

// lock ต่อใบ เก็บใน RAM ของ process เดียว (เปิดสาย = ถือ lock / ปิดสาย = ปล่อย)
// ⚠️ ใช้ได้กับ backend process เดียวเท่านั้น — รันหลาย process (PM2 cluster/Docker replica แม้เครื่องเดียว)
//    Map คนละก้อน lock จะซ้อน ต้องย้าย state+broadcast ไป Redis ก่อน
//
// ── ห้องแยกตาม scope ไม่ใช่ตาม requestId เปล่า ๆ ──────────────────────────────
// ใบเดียวกันมีคนทำงานพร้อมกันได้สองฝั่งโดยไม่ทับกัน: ผู้ขอแก้ชิ้นที่ถูกตีกลับ (draft)
// กับบัญชีออกเลขให้ชิ้นที่เหลือ (registration) ถ้าใช้ requestId เป็นคีย์เดียว สองฝั่งจะ
// ตกไปอยู่ห้องเดียวกันแล้วเข้าคิวรอกันทั้งที่คนละงาน — บัญชีเปิดใบไม่ได้เพราะผู้ขอถือ lock อยู่
//
// scope ต้องมาจาก route ไม่ใช่จาก client: ถ้ารับเป็น query param คนที่อยากแก้ทับก็แค่ส่ง
// scope มั่ว ๆ แล้วได้ห้องว่างที่ตัวเองเป็น holder ทันที lock พังเงียบ ๆ (ดู asset-request.routes.ts)

export type Scope = 'draft' | 'registration';

// ใบเดียวมีคนทำงานอยู่ได้ทั้งสองฝั่งพร้อมกัน — การกระจาย "สถานะเปลี่ยน" ต้องถึงทั้งคู่
// (บัญชีตีกลับชิ้นหนึ่ง ผู้ขอที่เปิดใบเดียวกันอยู่ต้องเห็นทันทีโดยไม่ต้องกด F5)
const SCOPES: readonly Scope[] = ['draft', 'registration'];

type PushFn = (event: SseEvent) => void;

/** ตัวตนของคนที่เข้าห้อง — ชื่อถูก resolve ที่ route แล้วส่งเข้ามา ไฟล์นี้จึงไม่แตะ DB เลย */
export interface Participant {
  id: number;
  name: string;
}

interface Member {
  userId: number;
  name: string;
  push: PushFn;
}

interface Room {
  scope: Scope;
  requestId: number;
  holderUserId: number | null;
  // เก็บชื่อคู่กับ id ที่ตัวห้อง ไม่ใช่ไปหาเอาจาก members ตอน broadcast — ช่วง grace
  // สมาชิกของ holder ถูกลบออกจาก members ไปแล้วแต่เขายังเป็น holder อยู่ ถ้าหาจาก members
  // จะได้ undefined พอดี แล้วป้ายบนจอคนอื่นจะกระพริบเป็น "ไม่มีคนแก้" แล้วเด้งกลับ
  holderName: string | null;
  holderAt: number | null;
  members: Member[];
  // grace: ตอน holder หลุดทุกสาย ตั้ง timer รอ reconnect ก่อน promote (กัน reload แล้วโดนแย่ง lock)
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<string, Room>();
const keyOf = (scope: Scope, requestId: number) => `${scope}:${requestId}`;

const HOLDER_TTL_MS = 15 * 60 * 1000;
// holder หลุดทุกสาย → รอเท่านี้เผื่อ reload/network blip กลับมา ก่อนจะ promote คนถัดไป
const RELEASE_GRACE_MS = 5000;

function holderStale(room: Room): boolean {
  return room.holderAt != null && Date.now() - room.holderAt > HOLDER_TTL_MS;
}

// ── lobby: สายเดียวต่อคนสำหรับ "หน้าตาราง" ที่ต้องรู้ว่าใบไหนใครแก้อยู่ ────────────
// ห้ามให้แต่ละแถวเปิดสาย presence ของตัวเอง — 10 แถวก็ 10 สาย ชนเพดาน connection ของ
// browser และที่แย่กว่าคือคนที่แค่เปิดดูตารางจะกลายเป็นสมาชิกทุกห้องแล้วไปแย่งคิวคนอื่น
// สาย lobby เป็นผู้ฟังอย่างเดียว ไม่ได้เข้าห้องไหน จึงไม่ถือ lock และไม่มีตัวตนในคิว
const lobby = new Set<PushFn>();

// ── สายของหน้า "คำขอของฉัน" ฝั่งผู้ขอ ────────────────────────────────────────
//
// ต่างจาก lobby ของบัญชีสองข้อ:
//   1. ไม่มี requireRole — ผู้ขอทุกคนเปิดได้ (มันบอกแค่ว่า "ไปโหลดลิสต์ของคุณใหม่")
//   2. payload เปล่า ไม่มี requestId — ดูเหตุผลที่ notifyStatus
//
// ไม่ส่ง snapshot ตอนต่อติดเหมือน lobby เพราะไม่มี state อะไรให้ sync — client โหลดลิสต์
// ของตัวเองผ่าน API ไปแล้วตอนเปิดหน้า สายนี้มีหน้าที่เดียวคือบอกว่า "ถึงเวลาโหลดใหม่"
const myRequests = new Set<PushFn>();

/**
 * เหตุการณ์นี้ทำให้ลิสต์ "คำขอของฉัน" เปลี่ยนไหม
 *
 * listMyDrafts กรอง DRAFT/REJECTED + ใบ APPROVED ที่มีชิ้นถูกตีกลับ (ดู hasRejectedAsset)
 * แถวจึงเข้า/ออกลิสต์ได้จากการตัดสินของคนอื่น ไม่ใช่แค่จากการกระทำของเจ้าตัว
 *
 * ★ กรองทิ้งให้มากที่สุด — สายนี้ยิงถึงผู้ขอ "ทุกคน" ที่เปิดหน้านั้นค้างอยู่ (ไม่มี requestId
 *   จึงกรองรายคนไม่ได้) ทุกก้อนที่ปล่อยผ่านคือ refetch คูณจำนวนคนที่เปิดหน้าอยู่
 */
function affectsMyRequestsList(change: StatusChange): boolean {
  switch (change.action) {
    // สถานะใบเปลี่ยน = ป้ายในลิสต์เปลี่ยน และบางกรณีแถวเข้า/ออกเลย
    case 'request-submitted':
    case 'request-approved':
    case 'request-rejected':
    // ตีกลับรายชิ้น = แถวโผล่เข้าลิสต์ / ปิดถาวรหรือปลดปิด = จำนวนชิ้นที่ค้างเปลี่ยน
    case 'asset-rejected':
    case 'asset-cancelled':
    case 'asset-uncancelled':
    // บัญชีแจ้งผลกลับ: COMPLETE = แถวหลุดจากลิสต์ / REJECTED = ยังอยู่แต่มีของต้องแก้
    case 'registration-confirmed':
      return true;
    // แก้ชิ้นตอนใบ APPROVED = แก้ชิ้นที่ถูกตีกลับ ชิ้นสุดท้ายที่แก้ทำให้แถวหลุดจากลิสต์
    // ตอนใบเป็น DRAFT การแก้ชิ้นไม่เปลี่ยนอะไรในลิสต์เลย และเป็น action ที่ยิงถี่ที่สุด
    // (ผู้ขอกรอกทีละชิ้นรัว ๆ) ปล่อยผ่านคือปลุกทุกคนทั้งวันฟรี ๆ
    case 'asset-updated':
      return change.requestStatus === 'APPROVED';
    // asset-created / asset-deleted / line-* แตะแค่ใบร่างของเจ้าตัวซึ่งอยู่ในลิสต์อยู่แล้ว
    // ไม่มีอะไรในลิสต์เปลี่ยน (ลิสต์ไม่ได้โชว์จำนวนชิ้น)
    default:
      return false;
  }
}

/**
 * สายฟังของหน้า "คำขอของฉัน" — ฟังอย่างเดียว ไม่เข้าห้องไหน จึงไม่ถือ lock ของใคร
 * ผู้ขอทุกคนเปิดได้ (authGuard พอ ไม่ต้อง requireRole) เพราะสิ่งที่ไหลออกไม่มีข้อมูลใบเลย
 */
export function openMyRequestsChanges(signal: AbortSignal | undefined) {
  return createSseStream(signal, (push) => {
    myRequests.add(push);
    return () => {
      myRequests.delete(push);
    };
  });
}

function lobbyEventFor(room: Room): SseEvent {
  const held = room.holderUserId !== null && !holderStale(room);
  return {
    event: 'holder',
    data: {
      requestId: room.requestId,
      holderUserId: held ? room.holderUserId : null,
      holderName: held ? room.holderName : null,
    },
  };
}

function notifyLobby(room: Room): void {
  // ตอนนี้หน้าตารางที่ต้องการข้อมูลนี้มีแค่ฝั่งบัญชี — ห้อง draft ไม่ต้องกระจายให้ใคร
  if (room.scope !== 'registration' || lobby.size === 0) return;
  const event = lobbyEventFor(room);
  for (const push of lobby) push(event);
}

// ── "สถานะงานเปลี่ยน" — ยัดลงสายที่เปิดอยู่แล้ว ไม่เปิดสายใหม่ ──────────────────
//
// browser เปิด connection ต่อ origin ได้ ~6 สายบน HTTP/1.1 และสาย SSE กินโควตาแบบไม่คืน
// สายที่สามสำหรับ "สถานะ" จึงเหลือให้ API แค่ 3 สายต่อแท็บ เปิดสองสามแท็บก็เริ่มเข้าคิว
// (อาการคือ request ค้างเงียบ ๆ ไม่ error — ดีบักยากที่สุดแบบหนึ่ง)
// สาย presence/lobby ที่หน้าพวกนี้เปิดค้างอยู่แล้วจึงรับงานนี้ต่อ แยกกันด้วยชื่อ event เท่านั้น
//
// ★ payload ต้องบางที่สุด — บอกแค่ "อะไรเปลี่ยน" ไม่ใช่ "เปลี่ยนเป็นอะไร" แล้วให้ client
//   ไปดึงของจริงผ่าน API ที่มี authGuard/requireRole คุมอยู่ ด้วยเหตุผลสองข้อ:
//     1. lobby เห็นทุกใบข้ามแผนก ถ้ายัดเนื้อข้อมูลใบลงไปด้วย = กระจายข้อมูลใบให้ทุกคนที่
//        เปิดหน้าคิวค้างไว้ โดยไม่ผ่านด่านสิทธิ์อีกเลย (requireRole ตรวจตอนเปิดสายครั้งเดียว
//        ไม่ได้ตรวจรายก้อนที่ส่งออก)
//     2. displayStatus เป็นค่าที่ backend คำนวณ (ดู asset.service.findSlotsByRequest)
//        ถ้าให้ client เอาก้อนนี้ไป patch state เอง จะมีสูตรสองชุดที่เพี้ยนกันได้เงียบ ๆ
export type StatusAction =
  // ระดับใบ
  | 'request-submitted'
  | 'request-approved'
  | 'request-rejected'
  | 'registration-confirmed'
  // ระดับชิ้น
  | 'asset-created'
  | 'asset-updated'
  | 'asset-deleted'
  | 'asset-numbered'
  | 'asset-rejected'
  | 'asset-cancelled'
  | 'asset-uncancelled'
  // ระดับรอบรับของ (กระทบตัวนับ "ลงได้อีกกี่ชิ้น" ของทั้งรอบ ไม่ใช่ของชิ้นใดชิ้นหนึ่ง)
  | 'line-declared'
  | 'line-reverted';

/** ตรงกับ enumRequestStatus — ไม่ import ตัว schema เข้ามาเพราะไฟล์นี้ตั้งใจไม่แตะ DB layer */
export type RequestStatusHint = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

export interface StatusChange {
  requestId: number;
  action: StatusAction;
  /**
   * สถานะใบ ณ ตอนที่เปลี่ยน — ตัวกรองว่าก้อนนี้ควรไปถึงหน้าคิวบัญชีไหม (ดู notifyStatus)
   *
   * ผู้เรียกรู้ค่านี้อยู่แล้วทุกจุด (ทุก mutation อ่านใบมาตรวจสถานะก่อนทำงานเสมอ) — จึงไม่
   * ต้องคิวรีเพิ่มเพื่อให้ได้มา
   */
  requestStatus: RequestStatusHint;
  /** ชิ้นที่เปลี่ยน — null = เปลี่ยนที่ระดับใบ/รอบ ให้โหลดทั้งหน้า */
  assetId: number | null;
  /**
   * คนที่ทำให้เปลี่ยน — client ทิ้งก้อนของตัวเองไป
   *
   * ไม่ใช่แค่เรื่องประหยัด request: คนที่กดปุ่มโหลดใหม่เองอยู่แล้วหลังได้ response และตอนนั้น
   * เขาอาจมีกล่องกรอกเปิดค้างอยู่ การโหลดทับจากก้อน echo จะล้างสิ่งที่เขาพิมพ์ไว้
   */
  actorId: number;
}

/**
 * กระจาย "ใบนี้/ชิ้นนี้เปลี่ยนแล้ว" ให้ทุกสายที่ควรรู้ — service เรียกตรง ๆ ได้
 *
 * ⚠️ ต้องเรียก **หลัง transaction commit แล้ว** เท่านั้น ยิงจากในทรานแซกชันแปลว่า client
 * ไปโหลดใหม่ทันทีแล้วเห็นข้อมูลก่อนหน้า (ยังมองไม่เห็นของที่ยังไม่ commit) จอจะค้างของเก่า
 * โดยไม่มี event รอบสองมาแก้ให้ — อาการเดียวกับ realtime พังแต่หาสาเหตุไม่เจอ
 *
 * เป็น push เข้าคิวใน RAM ล้วน ๆ ไม่รอ I/O — เรียกได้โดยไม่ต้อง await และไม่หน่วง flow ของปุ่ม
 */
export function notifyStatus(change: StatusChange): void {
  const event: SseEvent = { event: 'status', data: change };
  // สายของหน้าฟอร์ม — เฉพาะคนที่เปิดใบนี้อยู่ ทั้งฝั่งผู้ขอและฝั่งบัญชี
  for (const scope of SCOPES) {
    const room = rooms.get(keyOf(scope, change.requestId));
    if (!room) continue;
    for (const m of room.members) m.push(event);
  }
  // สายของหน้าคิวบัญชี — ต้องรู้ทุกใบ ไม่ใช่แค่ใบที่ตัวเองเปิดค้างอยู่: ตัวเลข x/y ในตาราง
  // ขยับตามการตัดสินรายชิ้นของคนอื่น และใบที่ปิดงานแล้วต้องหลุดออกจากคิวเอง
  //
  // ── สายของหน้า "คำขอของฉัน" — ส่งสัญญาณเปล่า ไม่มี requestId ไม่มี actorId
  //
  // ★ ทำไมไม่ส่งอะไรเลยนอกจาก action: สายนี้ไม่มีทางกรองรายคนได้ (จะรู้ว่าใบไหนของใครต้อง
  //   คิวรี asset_request_opener ซึ่งทำให้ notifyStatus จากที่เป็น push ใน RAM ล้วน ๆ
  //   กลายเป็นมี I/O และต้องเปลี่ยนเป็น async ทั้งเส้น) เมื่อกรองไม่ได้ ทางที่เหลือคือ
  //   ไม่ส่งอะไรที่ต้องกรอง — client เอาไปโหลดลิสต์ "ของตัวเอง" ผ่าน API ที่มี authGuard
  //   ซึ่งกรองด้วย assetRequestOpener ให้อยู่แล้ว ผลที่ผู้ใช้เห็นเหมือนกันเป๊ะ
  //
  // ★ ไม่กรอง echo ของตัวเองโดยตั้งใจ (จึงไม่ต้องมี actorId): ที่นี่ต่างจากหน้าฟอร์ม —
  //   คนที่แก้ชิ้นที่ถูกตีกลับชิ้นสุดท้ายเสร็จ ต้องเห็นแถวของตัวเองหลุดออกจากลิสต์ทันที
  //   การกรอง echo จะทำให้แถวค้างอยู่จนกว่าเขาจะกดโหลดใหม่เอง และหน้านี้ไม่มีกล่องกรอก
  //   จึงไม่มีอะไรให้ล้างทิ้ง
  if (affectsMyRequestsList(change)) {
    const signal: SseEvent = { event: 'changed', data: { action: change.action } };
    for (const push of myRequests) push(signal);
  }

  // ★ เฉพาะใบที่ APPROVED — คิวของบัญชีมีแค่ใบนั้น (ดู listPendingRegistration) สองเหตุผล:
  //   1. เสียงรบกวน: ผู้ขอทุกคนที่กรอกชิ้นเข้าใบ DRAFT ของตัวเองจะทำให้ตารางของบัญชี
  //      ทุกคนโหลดใหม่ฟรี ๆ ทั้งวัน ทั้งที่ใบนั้นไม่มีทางโผล่ในคิว
  //   2. ข้อมูลรั่ว: lobby ผ่าน requireRole ตอนเปิดสายครั้งเดียว ไม่ได้กรองรายก้อน —
  //      ไม่มีเหตุให้ requestId ของใบร่างข้ามแผนกไหลไปหาทุกคนที่เปิดหน้าคิวค้างไว้
  if (change.requestStatus !== 'APPROVED') return;
  for (const push of lobby) push(event);
}

/** ทางเดียวที่ holder เปลี่ยนค่า — รวมไว้ที่นี่เพื่อให้ lobby ไม่มีวันตกหล่นสักจังหวะ */
function setHolder(room: Room, member: Member | null): void {
  room.holderUserId = member ? member.userId : null;
  room.holderName = member ? member.name : null;
  room.holderAt = member ? Date.now() : null;
  notifyLobby(room);
}

// state ที่แต่ละคนในห้องควรเห็น: holder เห็น editable / ที่เหลือเห็น pending + ลำดับคิว
function presenceEventFor(room: Room, member: Member): SseEvent {
  if (room.holderUserId === member.userId) {
    return {
      event: 'presence',
      data: { state: 'editable', holder: room.holderUserId, holderName: room.holderName, position: 0 },
    };
  }
  const waiters = room.members.filter((m) => m.userId !== room.holderUserId);
  return {
    event: 'presence',
    data: {
      state: 'pending',
      holder: room.holderUserId,
      holderName: room.holderName,
      position: waiters.indexOf(member) + 1,
    },
  };
}

function broadcast(room: Room): void {
  for (const m of room.members) m.push(presenceEventFor(room, m));
}

// grace หมดแล้ว holder ยังไม่กลับ → promote หัวคิว (หรือปิดห้องถ้าว่าง)
function releaseHolder(key: string, room: Room): void {
  room.releaseTimer = null;
  setHolder(room, room.members[0] ?? null);
  if (room.members.length === 0) rooms.delete(key);
  else broadcast(room);
}

export function subscribe(
  scope: Scope,
  requestId: number,
  participant: Participant,
  push: PushFn,
): Member {
  const key = keyOf(scope, requestId);
  let room = rooms.get(key);
  if (!room) {
    room = {
      scope,
      requestId,
      holderUserId: null,
      holderName: null,
      holderAt: null,
      members: [],
      releaseTimer: null,
    };
    rooms.set(key, room);
  }
  const member: Member = { userId: participant.id, name: participant.name, push };
  room.members.push(member);

  if (room.holderUserId === null || holderStale(room)) {
    setHolder(room, member);
  } else if (room.holderUserId === participant.id) {
    // holder เดิมกลับมา (เช่น reload) → ยกเลิก grace ที่ตั้งไว้ตอนสายเก่าหลุด จะได้ไม่โดนแย่ง lock
    setHolder(room, member);
    if (room.releaseTimer) {
      clearTimeout(room.releaseTimer);
      room.releaseTimer = null;
    }
  }

  broadcast(room);
  return member;
}

export function unsubscribe(scope: Scope, requestId: number, member: Member): void {
  const key = keyOf(scope, requestId);
  const room = rooms.get(key);
  if (!room) return;
  room.members = room.members.filter((m) => m !== member);

  const userStillHere = room.members.some((m) => m.userId === member.userId);
  const holderLeft = room.holderUserId === member.userId && !userStillHere;

  if (holderLeft) {
    if (room.releaseTimer) clearTimeout(room.releaseTimer);
    room.releaseTimer = setTimeout(() => releaseHolder(key, room), RELEASE_GRACE_MS);
  }

  if (room.members.length > 0) {
    broadcast(room); // ระหว่าง grace holder ยังเป็นคนเดิม — คนอื่นเห็น pending ต่ออีกแป๊บ
  } else if (!room.releaseTimer) {
    // ว่างจริงและไม่มี grace ค้าง → ปล่อย holder (บอก lobby ว่าใบนี้ว่างแล้ว) แล้วเก็บห้องทิ้ง
    setHolder(room, null);
    rooms.delete(key);
  }
  // ว่างแต่มี grace ค้าง → คงห้องไว้ให้ holder reconnect ได้ (releaseHolder จะลบเองถ้า grace หมด)
}

/**
 * ล้างห้องทั้งหมด — สำหรับเทสต์เท่านั้น
 *
 * `rooms` เป็น singleton ระดับ process จึงค้างข้ามเทสต์ ในขณะที่ resetDb() รีเซ็ต id ให้เริ่ม
 * ใหม่ทุกครั้ง ผลคือ requestId ซ้ำกันแล้วเทสต์ถัดไปไปเจอห้องของเทสต์ก่อนหน้าที่ยังมี holder
 * ค้างอยู่ (และ releaseTimer ที่ยังไม่ยิงจะกอง process ไว้ไม่ให้จบด้วย)
 */
export function resetRooms(): void {
  for (const room of rooms.values()) {
    if (room.releaseTimer) clearTimeout(room.releaseTimer);
  }
  rooms.clear();
  lobby.clear();
  myRequests.clear();
}

export function isHolder(scope: Scope, requestId: number, userId: number): boolean {
  const room = rooms.get(keyOf(scope, requestId));
  if (!room || holderStale(room)) return false;
  return room.holderUserId === userId;
}

export function getHolder(scope: Scope, requestId: number): Participant | null {
  const room = rooms.get(keyOf(scope, requestId));
  if (!room || holderStale(room) || room.holderUserId === null) return null;
  return { id: room.holderUserId, name: room.holderName ?? '' };
}

export function openPresence(
  scope: Scope,
  requestId: number,
  participant: Participant,
  signal: AbortSignal | undefined,
) {
  return createSseStream(signal, (push) => {
    const member = subscribe(scope, requestId, participant, push);
    return () => unsubscribe(scope, requestId, member);
  });
}

/**
 * สายของหน้าตารางฝั่งบัญชี — ฟังอย่างเดียว ไม่เข้าห้องไหน จึงไม่ถือ lock ของใคร
 * เปิดสายแล้วได้ snapshot ของใบที่มีคนถืออยู่ตอนนี้ก่อน แล้วค่อยได้ event ตอนมีการเปลี่ยนแปลง
 * (ถ้าไม่ส่ง snapshot ตอนเปิด คนที่เพิ่งเข้าหน้าจะเห็นทุกใบว่าง จนกว่าจะมีใครเข้า/ออกสักคน)
 */
export function openRegistrationLobby(signal: AbortSignal | undefined) {
  return createSseStream(signal, (push) => {
    for (const room of rooms.values()) {
      if (room.scope === 'registration' && room.holderUserId !== null && !holderStale(room)) {
        push(lobbyEventFor(room));
      }
    }
    lobby.add(push);
    return () => {
      lobby.delete(push);
    };
  });
}
