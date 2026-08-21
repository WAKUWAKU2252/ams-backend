// ผลอนุมัติที่เด้งกลับมาจาก Teams -> สถานะจริงใน asset_request
//
// โมดูลนี้ไม่ได้เขียนสถานะเอง — แปลงตัวตนจาก Teams ให้เป็น user.id แล้วส่งต่อให้
// asset-request.service ซึ่งเป็นเจ้าของ state machine (กติกาว่าใบไหนเปลี่ยนเป็นอะไรได้
// อยู่ที่เดียวเสมอ ไม่งั้นอนุมัติผ่าน Teams กับผ่านหน้าเว็บจะเช็คคนละชุด)

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@intrastucture/db';
import { assetRequest, role, user } from '@intrastucture/db/schema';
import { ConflictError, NotFoundError } from '@common/errors';
import { APPROVER_ROLES, APPROVER_ROLE_LIST } from '@common/roles';
import * as assetRequestService from '@modules/business/asset-request/asset-request.service';

/** ผลที่การ์ดส่งกลับมาได้ — ตรงกับ actionResult ของปุ่มใน buildAdaptiveCard */
export type TeamsDecision = 'Approved' | 'Rejected';

export interface ApplyDecisionInput {
  requestId: number;
  /** employee.id ของหัวหน้า ที่เราส่งไปกับใบแล้ว flow เด้งกลับมา */
  approvedBy: number;
  status: TeamsDecision;
  comments: string;
}

/**
 * employee.id -> user.id ของหัวหน้า
 *
 * asset_request.approvedBy/rejectedBy ชี้ user.id แต่ฝั่ง Teams รู้จักแค่ employee.id
 * (department.managerId ชี้ employee) จึงต้องแปลงตรงนี้
 *
 * บังคับ role ที่อนุมัติได้ด้วย (APPROVER_ROLES) ไม่ใช่แค่หา user ที่ผูกกับพนักงานคนนั้น —
 * ให้ผลเท่ากับ requireRole(...) ที่กั้น POST /asset-requests/:id/approve อยู่
 * ไม่งั้น Teams จะกลายเป็นทางลัดที่อนุมัติได้โดยไม่ต้องมีสิทธิ์
 */
// คืน role มาด้วย ไม่ใช่แค่ id — การตีกลับต้องบันทึกว่ามาจาก role ไหน (asset_request.rejectedRole)
// และตรงนี้ join ตาราง role อยู่แล้วเพื่อคัดสิทธิ์ จึงไม่มีคิวรีเพิ่ม
async function resolveManagerUserId(employeeId: number): Promise<{ id: number; roleName: string }> {
  const [row] = await db
    .select({ id: user.id, roleName: role.name })
    .from(user)
    .innerJoin(role, eq(role.id, user.roleId))
    .where(
      and(
        eq(user.employeeId, employeeId),
        inArray(role.name, APPROVER_ROLE_LIST),
        eq(user.isActive, true),
        isNull(user.deletedAt),
      ),
    );

  if (!row) {
    // ข้อความชี้เป้าให้แอดมินไปสร้าง/แก้บัญชี ไม่ใช่แค่บอกว่าไม่มีสิทธิ์
    throw new NotFoundError(
      `บัญชีผู้ใช้ที่อนุมัติได้ของพนักงาน id ${employeeId} (ต้องมี user ที่เปิดใช้งานและ role เป็น ${APPROVER_ROLES.join('/')})`,
    );
  }
  return row;
}

/**
 * บันทึกผลอนุมัติจาก Teams
 *
 * idempotent: Power Automate ยิงซ้ำได้เอง (retry) และคนกดปุ่มค้างสองครั้งก็ได้
 * ถ้าใบอยู่ในสถานะปลายทางที่ตรงกับผลที่ส่งมาแล้ว ให้ถือว่าสำเร็จและตอบ applied: false
 * — โยน error ตรงนี้จะทำให้ flow ขึ้นแดงทั้งที่ครั้งแรกทำสำเร็จไปแล้ว
 *
 * ส่วนกรณีที่สถานะไปทางอื่น (เช่นอนุมัติไปแล้วแต่ส่ง Rejected ตามมา) ปล่อยให้
 * approveRequest/rejectRequest โยน ConflictError ตามกติกาเดิม — ไม่ใช่การยิงซ้ำ
 * แต่เป็นคำสั่งที่ขัดกัน ซึ่งต้องมีคนไปดู
 */
export async function applyDecision({ requestId, approvedBy, status, comments }: ApplyDecisionInput) {
  const req = await db.query.assetRequest.findFirst({
    columns: { status: true },
    where: and(eq(assetRequest.id, requestId), isNull(assetRequest.deletedAt)),
  });
  if (!req) throw new NotFoundError(`Asset request ${requestId}`);

  const target = status === 'Approved' ? 'APPROVED' : 'REJECTED';
  if (req.status === target) {
    return { requestId, status: req.status, applied: false };
  }

  // ตีกลับต้องมีเหตุผลเสมอ — การ์ดบังคับให้แล้ว (isRequired มีผลกับปุ่ม Reject)
  // เช็คซ้ำที่นี่เพราะการ์ดเป็นฝั่ง client: flow แก้ได้ การ์ดเวอร์ชันเก่ายังลอยอยู่ใน Teams ได้
  // และ rejectRequest() บังคับ reason อยู่แล้ว ปล่อยค่าว่างไปจะได้ใบที่ไม่มีใครรู้ว่าต้องแก้อะไร
  const reason = comments.trim();
  if (status === 'Rejected' && !reason) {
    throw new ConflictError('ตีกลับต้องระบุเหตุผล — ไม่พบข้อความในช่องความคิดเห็น');
  }

  const manager = await resolveManagerUserId(approvedBy);

  // สองสาขาคืนรูปเดียวกันเสมอ ({ id, status }) แต่ประกอบเป็น requestId ให้ตรงกับ
  // สาขายิงซ้ำข้างบน — คนเรียกจะได้ไม่ต้องแยกอ่านคนละชื่อตามผลลัพธ์
  const row =
    status === 'Approved'
      ? await assetRequestService.approveRequest(requestId, manager.id)
      : await assetRequestService.rejectRequest(requestId, manager.id, reason, manager.roleName);

  return { requestId: row.id, status: row.status, applied: true };
}
