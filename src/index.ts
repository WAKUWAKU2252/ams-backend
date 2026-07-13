import { env } from './config/env';
import { AppDataSource } from './db/data-source';
import { createApp } from './app';

await AppDataSource.initialize();
console.log(`✅ PostgreSQL connected: ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);

const app = createApp().listen(env.PORT);

console.log(`🦊 AMS API running at http://localhost:${env.PORT}`);
console.log(`📖 Swagger UI: http://localhost:${env.PORT}/swagger`);
