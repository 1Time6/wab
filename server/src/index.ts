import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Store } from './db.js';
import { syncRoutes } from './routes/sync.js';
import { checkRoutes } from './routes/check.js';
import { customerRoutes } from './routes/customers.js';
import { accountRoutes } from './routes/accounts.js';
import { dailyRoutes } from './routes/daily.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..'); // server/
const PORT = Number(process.env.WAB_PORT ?? 3900);
const HOST = process.env.WAB_HOST ?? '127.0.0.1';
const DB_PATH = process.env.WAB_DB ?? join(ROOT, 'data', 'wab.db');

const store = new Store(DB_PATH);
const app = Fastify({ logger: { level: process.env.WAB_LOG ?? 'info' } });

// 扩展来自 chrome-extension:// 和 https://web.whatsapp.com，全部放行（服务只监听本机）
await app.register(cors, { origin: true });
await app.register(fastifyStatic, { root: join(ROOT, 'public'), prefix: '/' });

app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString(), db: DB_PATH }));
syncRoutes(app, store);
checkRoutes(app, store);
customerRoutes(app, store);
accountRoutes(app, store);
dailyRoutes(app, store);

const shutdown = async () => {
  await app.close();
  store.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: PORT, host: HOST });
