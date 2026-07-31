import { createSseStream, type SseEvent } from '../../common/sse';

// lock ต่อ PO เก็บใน RAM ของ process เดียว (เปิดสาย = ถือ lock / ปิดสาย = ปล่อย)
// ⚠️ ใช้ได้กับ backend process เดียวเท่านั้น — รันหลาย process (PM2 cluster/Docker replica แม้เครื่องเดียว)
//    Map คนละก้อน lock จะซ้อน ต้องย้าย state+broadcast ไป Redis ก่อน

type PushFn = (event: SseEvent) => void;

interface Member {
  userId: number;
  push: PushFn;
}

interface Room {
  holderUserId: number | null;
  holderAt: number | null;
  members: Member[];
  // grace: ตอน holder หลุดทุกสาย ตั้ง timer รอ reconnect ก่อน promote (กัน reload แล้วโดนแย่ง lock)
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

const rooms = new Map<number, Room>();
const HOLDER_TTL_MS = 15 * 60 * 1000;
// holder หลุดทุกสาย → รอเท่านี้เผื่อ reload/network blip กลับมา ก่อนจะ promote คนถัดไป
const RELEASE_GRACE_MS = 5000;

function holderStale(room: Room): boolean {
  return room.holderAt != null && Date.now() - room.holderAt > HOLDER_TTL_MS;
}

// state ที่แต่ละคนในห้องควรเห็น: holder เห็น editable / ที่เหลือเห็น pending + ลำดับคิว
function presenceEventFor(room: Room, member: Member): SseEvent {
  if (room.holderUserId === member.userId) {
    return { event: 'presence', data: { state: 'editable', holder: room.holderUserId, position: 0 } };
  }
  const waiters = room.members.filter((m) => m.userId !== room.holderUserId);
  return {
    event: 'presence',
    data: { state: 'pending', holder: room.holderUserId, position: waiters.indexOf(member) + 1 },
  };
}

function broadcast(room: Room): void {
  for (const m of room.members) m.push(presenceEventFor(room, m));
}

// grace หมดแล้ว holder ยังไม่กลับ → promote หัวคิว (หรือปิดห้องถ้าว่าง)
function releaseHolder(requestId: number, room: Room): void {
  room.releaseTimer = null;
  const next = room.members[0];
  room.holderUserId = next ? next.userId : null;
  room.holderAt = next ? Date.now() : null;
  if (room.members.length === 0) rooms.delete(requestId);
  else broadcast(room);
}

export function subscribe(requestId: number, userId: number, push: PushFn): Member {
  let room = rooms.get(requestId);
  if (!room) {
    room = { holderUserId: null, holderAt: null, members: [], releaseTimer: null };
    rooms.set(requestId, room);
  }
  const member: Member = { userId, push };
  room.members.push(member);

  if (room.holderUserId === null || holderStale(room)) {
    room.holderUserId = userId;
    room.holderAt = Date.now();
  } else if (room.holderUserId === userId) {
    // holder เดิมกลับมา (เช่น reload) → ยกเลิก grace ที่ตั้งไว้ตอนสายเก่าหลุด จะได้ไม่โดนแย่ง lock
    room.holderAt = Date.now();
    if (room.releaseTimer) {
      clearTimeout(room.releaseTimer);
      room.releaseTimer = null;
    }
  }

  broadcast(room);
  return member;
}

export function unsubscribe(requestId: number, member: Member): void {
  const room = rooms.get(requestId);
  if (!room) return;
  room.members = room.members.filter((m) => m !== member);

  const userStillHere = room.members.some((m) => m.userId === member.userId);
  const holderLeft = room.holderUserId === member.userId && !userStillHere;

  if (holderLeft) {
    if (room.releaseTimer) clearTimeout(room.releaseTimer);
    room.releaseTimer = setTimeout(() => releaseHolder(requestId, room), RELEASE_GRACE_MS);
  }

  if (room.members.length > 0) {
    broadcast(room); // ระหว่าง grace holder ยังเป็นคนเดิม — คนอื่นเห็น pending ต่ออีกแป๊บ
  } else if (!room.releaseTimer) {
    rooms.delete(requestId); // ว่างจริงและไม่มี grace ค้าง → เก็บห้องทิ้ง
  }
  // ว่างแต่มี grace ค้าง → คงห้องไว้ให้ holder reconnect ได้ (releaseHolder จะลบเองถ้า grace หมด)
}

export function isHolder(requestId: number, userId: number): boolean {
  const room = rooms.get(requestId);
  if (!room || holderStale(room)) return false;
  return room.holderUserId === userId;
}

export function getHolder(requestId: number): number | null {
  const room = rooms.get(requestId);
  if (!room || holderStale(room)) return null;
  return room.holderUserId;
}

export function openPresence(requestId: number, userId: number, signal: AbortSignal | undefined) {
  return createSseStream(signal, (push) => {
    const member = subscribe(requestId, userId, push);
    return () => unsubscribe(requestId, member);
  });
}
