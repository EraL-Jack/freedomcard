import { io, type Socket } from 'socket.io-client';

/**
 * 全应用共用一个 socket 实例。
 * 同源连接：由 Vite 代理转发到服务端，手机走局域网时也能连上（无需处理 CORS）。
 */
export const socket: Socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
