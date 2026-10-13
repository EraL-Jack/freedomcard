import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

// 只引子路径，避免把 zod 拖进首屏产物。
import { SOCKET_EVENTS } from '@app/shared/constants';

interface Health {
  ok: boolean;
  version: string;
}

type LinkState = 'connecting' | 'online' | 'offline';

export default function App(): React.JSX.Element {
  const [health, setHealth] = useState<Health | null>(null);
  const [socketState, setSocketState] = useState<LinkState>('connecting');
  const [echoReply, setEchoReply] = useState<string>('—');

  useEffect(() => {
    const controller = new AbortController();

    void fetch('/health', { signal: controller.signal })
      .then((res) => res.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth(null));

    // 同源连接：由 Vite 代理转发到服务端，手机走局域网时也能连上。
    const socket: Socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });

    socket.on('connect', () => {
      setSocketState('online');
      socket.emit(SOCKET_EVENTS.echo, { message: 'ping' }, (res: unknown) => {
        setEchoReply(JSON.stringify(res));
      });
    });
    socket.on('disconnect', () => setSocketState('offline'));
    socket.on('connect_error', () => setSocketState('offline'));

    return () => {
      controller.abort();
      socket.close();
    };
  }, []);

  return (
    <main className="min-h-dvh bg-slate-950 p-4 text-slate-100 sm:p-6 md:p-8 lg:p-10">
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold sm:text-2xl md:text-3xl">卡牌对战 Demo · 骨架</h1>

        <section className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <h2 className="mb-2 text-sm font-medium text-slate-400">服务端状态</h2>
          <p className="text-lg">
            {socketState === 'online' ? (
              <span className="text-emerald-400">服务端已连接</span>
            ) : socketState === 'connecting' ? (
              <span className="text-amber-400">连接中…</span>
            ) : (
              <span className="text-rose-400">服务端未连接</span>
            )}
          </p>
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm">
          <h2 className="mb-2 font-medium text-slate-400">HTTP /health</h2>
          <pre className="overflow-x-auto text-emerald-300">
            {health ? JSON.stringify(health, null, 2) : '请求失败'}
          </pre>
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm">
          <h2 className="mb-2 font-medium text-slate-400">Socket echo 回包</h2>
          <pre className="overflow-x-auto text-sky-300">{echoReply}</pre>
        </section>

        <p className="text-xs text-slate-500">
          玩法相关的一切尚未定义 —— 规则与界面由 Era 在 <code>docs/06</code> 输入后实现。
        </p>
      </div>
    </main>
  );
}
