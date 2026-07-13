import { env } from './config/env';
import { connectDb } from './db';
import { createApp } from './app';

await connectDb();
console.log(`✅ PostgreSQL connected: ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);

const app = createApp().listen(env.PORT);

console.log(`🦊 AMS API running at http://localhost:${env.PORT}`);
console.log(`📖 Swagger UI: http://localhost:${env.PORT}/swagger`);
