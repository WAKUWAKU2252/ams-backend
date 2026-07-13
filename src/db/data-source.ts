import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { env } from '../config/env';
import { PurchaseOrder } from '../modules/purchase-order/purchase-order.entity';
import { PurchaseOrderItem } from '../modules/purchase-order/purchase-order-item.entity';
import { GrpoLine } from '../modules/grpo/grpo-line.entity';

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USERNAME,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  entities: [PurchaseOrder, PurchaseOrderItem, GrpoLine],
  // schema จัดการผ่าน migration เท่านั้น — ห้ามเปิด synchronize กับ DB ที่มีข้อมูลจริง
  synchronize: false,
  migrations: ['src/db/migrations/*.ts'],
});
