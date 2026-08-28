import { createSseStream, type SseEvent } from '@common/sse';
export type Scope = 'draft' | 'registration';
const SCOPES: readonly Scope[] = ['draft', 'registration'];

type PushFn = (event: SseEvent) => void;
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
  holderName: string | null;
  holderAt: number | null;
  members: Member[];
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

function affectsMyRequestsList(change: StatusChange): boolean {
  switch (change.action) {
    case 'request-submitted':
    case 'request-approved':
    case 'request-rejected':
    case 'asset-rejected':
    case 'asset-cancelled':
    case 'asset-uncancelled':
    case 'registration-confirmed':
      return true;
    case 'asset-updated':
      return change.requestStatus === 'APPROVED';
    default:
      return false;
  }
}
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
  | 'line-declared'
  | 'line-reverted';

export type RequestStatusHint = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';

export interface StatusChange {
  requestId: number;
  action: StatusAction;
  requestStatus: RequestStatusHint;
  assetId: number | null;
  actorId: number;
}
export function notifyStatus(change: StatusChange): void {
  const event: SseEvent = { event: 'status', data: change };
  // สายของหน้าฟอร์ม — เฉพาะคนที่เปิดใบนี้อยู่ ทั้งฝั่งผู้ขอและฝั่งบัญชี
  for (const scope of SCOPES) {
    const room = rooms.get(keyOf(scope, change.requestId));
    if (!room) continue;
    for (const m of room.members) m.push(event);
  }
  if (affectsMyRequestsList(change)) {
    const signal: SseEvent = { event: 'changed', data: { action: change.action } };
    for (const push of myRequests) push(signal);
  }
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
