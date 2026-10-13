import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { Server as IOServer } from 'socket.io';

import { EchoSchema, SOCKET_EVENTS, type EchoPayload } from '@app/shared';

/** 与 packages/server/package.json 的 version 保持一致。 */
const VERSION = '0.1.0';
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

/**
 * 生产形态下由服务端托管客户端构建产物（`SERVE_STATIC=1`）。
 * 开发态不启用 —— 那时由 Vite dev server 提供页面并代理 /health 与 /socket.io。
 */
const SERVE_STATIC = process.env.SERVE_STATIC === '1';
const CLIENT_DIST = fileURLToPath(new URL('../../client/dist', import.meta.url));

const fastify = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

fastify.get('/health', async () => ({ ok: true as const, version: VERSION }));

if (SERVE_STATIC) {
  const [{ default: fastifyStatic }, { readFile }] = await Promise.all([
    import('@fastify/static'),
    import('node:fs/promises'),
  ]);
  await fastify.register(fastifyStatic, { root: CLIENT_DIST, prefix: '/' });
  // SPA 回退：未命中的 GET 一律返回 index.html，交给前端路由。
  fastify.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET') {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    const html = await readFile(`${CLIENT_DIST}/index.html`);
    return reply.type('text/html').send(html);
  });
}

await fastify.listen({ port: PORT, host: HOST });

const io = new IOServer(fastify.server, {
  cors: { origin: true },
});

io.on('connection', (socket) => {
  fastify.log.info({ socketId: socket.id }, 'client connected');

  socket.on(SOCKET_EVENTS.echo, (raw: unknown, ack?: (res: unknown) => void) => {
    // 运行时校验只发生在服务端入站处（ADR：客户端不引入 zod）。
    const parsed = EchoSchema.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, error: 'INVALID_PAYLOAD' });
      return;
    }
    const payload: EchoPayload = parsed.data;
    ack?.({ ok: true, message: payload.message, at: Date.now() });
  });

  socket.on('disconnect', (reason) => {
    fastify.log.info({ socketId: socket.id, reason }, 'client disconnected');
  });
});

fastify.log.info({ port: PORT, host: HOST }, 'server ready');
