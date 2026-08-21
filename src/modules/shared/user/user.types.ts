// สัญญาชนิดข้อมูลของโมดูล user
import type { user } from '@intrastucture/db/schema';
import type { createUserBody } from './user.schema';

export type UserRow = typeof user.$inferSelect;

export type CreateUserInput = typeof createUserBody.static;

/**
 * user ที่ปลอดภัยพอจะส่งออก API — คือ UserRow ที่ตัด passwordHash ทิ้ง
 *
 * ประกาศเป็นชนิดที่ derive จากตาราง ไม่ใช่พิมพ์ฟิลด์ซ้ำด้วยมือ: วันที่เพิ่มคอลัมน์
 * ความลับใหม่ในตาราง user มันจะโผล่ที่นี่ทันทีให้เห็นว่าต้องตัดออกด้วยไหม
 * (ถ้าพิมพ์เองจะเงียบ แล้วของใหม่หลุดออก API โดยไม่มีใครรู้)
 */
export interface PublicUser extends Omit<UserRow, 'passwordHash'> {}
