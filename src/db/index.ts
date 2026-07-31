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
  // local (Docker) = false ต่อแบบเดิม / server จริงตั้ง DB_SSL=true
  ssl: env.DB_SSL ? { rejectUnauthorized: true } : false,
  // จำกัดเพดาน connection กันเปิดจนเต็ม limit ของ DB ที่ใช้ร่วมกัน
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const db = drizzle(pool, { schema });

export async function connectDb() {
  await pool.query('SELECT 1');
}
