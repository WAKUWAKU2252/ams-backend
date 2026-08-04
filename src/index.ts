import { env } from './config/env';
import { connectDb } from './db';
import { createApp } from './app';
import { cleanupOrphans } from './modules/upload';

await connectDb();
console.log(`✅ PostgreSQL connected: ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}`);

const app = createApp().listen(env.PORT);

console.log(`🦊 AMS API running at http://localhost:${env.PORT}`);
console.log(`📖 Swagger UI: http://localhost:${env.PORT}/swagger`);

const runCleanup = () =>
  cleanupOrphans()
    .then((n) => {
      if (n > 0) console.log(`🧹 deleted files with no relation: ${n} file`);
    })
    .catch(console.error); 

runCleanup();
setInterval(runCleanup, 60 * 60 * 1000); 

