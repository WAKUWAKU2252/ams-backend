import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import * as schema from './schema';

// pool เดียวของทั้งแอป — service ทุกตัว import { db } จากที่นี่
const pool = new Pool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  user: env.DB_USERNAME,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
});

export const db = drizzle(pool, { schema });

// ping ตอน boot เพื่อ fail fast ถ้าต่อ DB ไม่ได้ (แทน DataSource.initialize เดิม)
export async function connectDb() {
  await pool.query('SELECT 1');
}
