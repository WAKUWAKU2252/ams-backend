export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super(`${what} not found`, 404);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string) {
    super(message, 400);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409);
  }
}

// 401 — ยังไม่ยืนยันตัวตน (ไม่มี token / token พัง / หมดอายุ)
export class UnauthorizedError extends AppError {
  constructor(message = 'ต้องเข้าสู่ระบบก่อน') {
    super(message, 401);
  }
}

// 403 — ยืนยันตัวตนแล้วแต่สิทธิ์ไม่พอ (role ไม่ตรง)
export class ForbiddenError extends AppError {
  constructor(message = 'สิทธิ์ไม่พอสำหรับการทำรายการนี้') {
    super(message, 403);
  }
}

// 503 — เส้นทางนี้ยังใช้ไม่ได้เพราะ "ระบบยังไม่ถูกตั้งค่า" ไม่ใช่เพราะคำขอผิด
//
// แยกจาก 4xx โดยตั้งใจ: คนที่ต้องไปแก้คือคนดูแลระบบ (ไปเติม env) ไม่ใช่คนที่ยิงคำขอมา
// — ถ้าตอบ 400/401 คนที่เจอจะเข้าใจว่าตัวเองส่งของผิดแล้วไล่แก้ผิดทาง
export class ServiceUnavailableError extends AppError {
  constructor(message: string) {
    super(message, 503);
  }
}
