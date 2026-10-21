/**
 * 生产形态的静态托管判定（issue #107 / D-273）。
 *
 * 这两个函数从 `index.ts` 里抽出来的唯一理由是**能单测**：它们是「缺资源时页面会不会
 * 静默变成白纸」这件事的全部判断，却一直被埋在启动脚本里，没有任何测试碰得到。
 *
 * 真实事故（Era 2026-10-21 手机浏览器）：
 * ```
 * GET /assets/index-OLDHASH.css
 * 200 OK · content-type: text/html · content-length: 446   ← 内容其实是 index.html
 * ```
 * 浏览器按 MIME 拒绝解析样式表，页面变成白底黑字，控制台也没有红字 ——
 * 玩家只能得出「游戏坏了」。
 */

/** 前端路由常见前缀 —— 这些路径未命中静态文件时回 index.html。 */
const SPA_PREFIXES = ['/', ''];

/**
 * 这个 URL 该不该走 SPA 回退（回 `index.html`）？
 *
 * 判据：**像前端路由**才回。`/assets/*`、`/socket.io/*`、`/health` 以及任何
 * 带扩展名的路径都不是路由 —— 它们 404 才是诚实的回答。
 *
 * 为什么要排除扩展名：将来 `manifest.webmanifest`、`robots.txt`、`sw.js` 这类文件
 * 一旦缺失，用 HTML 冒充同样会静默失败，而且是更难查的那种（SW 不注册 + 无报错）。
 */
export function isSpaRoute(rawUrl: string): boolean {
  const path = rawUrl.split('?')[0]!.split('#')[0]!;
  if (path === '' || path === '/') return true;
  if (path.startsWith('/assets/') || path === '/assets') return false;
  if (path.startsWith('/socket.io')) return false;
  if (path === '/health' || path.startsWith('/health/')) return false;
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  // 带扩展名 = 资源请求（index.html 自己也是，但它只会被内部读盘，不会走这里）
  if (lastSegment.includes('.')) return false;
  return SPA_PREFIXES.some((p) => path.startsWith(p));
}

/**
 * 静态文件的 `cache-control`（按路径给）。
 *
 * - `assets/` 下是 **Vite 的内容哈希产物** —— 内容变则文件名变，可以永久缓存；
 *   不设长缓存的话，每次打开都要重新校验 CSS 39 kB + JS 407 kB，穿过公网隧道
 *   多一次失败机会（Era 报的「偶现无样式」正是这条路）。
 * - `index.html` 必须 `no-cache`：它决定加载哪个哈希包，缓存住它等于发版后
 *   浏览器还在跑旧包。
 * - 其它文件返回 `undefined`，沿用 `@fastify/static` 的默认值。
 *
 * 注意入参是**文件系统路径**（Windows 上是反斜杠），所以两种分隔符都要认。
 */
export function cacheControlFor(filePath: string): string | undefined {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/assets/')) return 'public, max-age=31536000, immutable';
  if (normalized.endsWith('.html')) return 'no-cache';
  return undefined;
}
