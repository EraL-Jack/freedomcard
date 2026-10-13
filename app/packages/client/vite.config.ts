import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const SERVER_ORIGIN = process.env.SERVER_ORIGIN ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // 局域网联机测：手机访问 http://<本机IP>:5173
    port: 5173,
    proxy: {
      '/health': { target: SERVER_ORIGIN, changeOrigin: true },
      '/socket.io': { target: SERVER_ORIGIN, changeOrigin: true, ws: true },
    },
  },
});
