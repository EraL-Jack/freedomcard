#!/usr/bin/env node
/**
 * 客户端构建：**先构建到临时目录，再增量复制进 `dist/`，最后替换 index.html**
 * （issue #107 / D-273）。
 *
 * ## 为什么不是直接 `vite build`
 *
 * Vite 默认先清空 `dist/` 再写入 —— 重建那几秒里，正在打开的页面拿到的 `index.html`
 * 会指向**已经不存在的** `assets/index-*.js`。生产形态下更糟：服务端原来的 SPA 回退
 * 会把这些缺失资源当路由、回 `200 + index.html`，浏览器按 MIME 拒绝解析 →
 * 整页无样式、控制台无报错（Era 2026-10-21 的手机现场）。
 *
 * ## 为什么不用「rename 目录」那一版
 *
 * 原本想 `dist` → `dist.old` → `dist.new` → `dist` 两次改名（POSIX 常见做法）。
 * **本机实测不可行**：Windows 上 `fs.renameSync` 对**有内容的目录**返回
 * `EPERM: operation not permitted`（新建一个空目录改名可以，装满文件后就不行；
 * 本机上连 `dist.old → distA` 这种无冲突改名也一样被拒），
 * 第一次试跑把 `dist/` 直接弄丢了几分钟。
 *
 * ## 现在的做法（A/B 安全，无需改名）
 *
 * 1. 构建到 `dist.new/`（这一步失败时 `dist/` 原样保留，线上不受影响）；
 * 2. 把 `dist.new/` **增量复制**进 `dist/`（同名覆盖，旧的哈希资源不动）；
 * 3. **最后**才覆盖 `dist/index.html` —— 它是「加载哪套资源」的指针：
 *    先有资源、后换指针，任何时刻打开页面都能拿到完整的一套；
 * 4. 清掉**两代之前**的资源：只保留「新 index.html 引用的」∪「旧 index.html 引用的」。
 *    留着上一代，是为了让「刚加载完旧页面、正在下一次资源请求」的客户端不至于 404。
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const clientDir = join(here, '..', 'packages', 'client');
const dist = join(clientDir, 'dist');
const next = join(clientDir, 'dist.new');

/** index.html 里引用到的资源文件名（形如 `assets/index-abc.js`）。 */
function referencedAssets(htmlPath) {
  if (!existsSync(htmlPath)) return new Set();
  const html = readFileSync(htmlPath, 'utf8');
  const out = new Set();
  for (const m of html.matchAll(/(?:src|href)="\/?([^"]+)"/g)) out.add(m[1]);
  return out;
}

rmSync(next, { recursive: true, force: true });
execSync('npx vite build --outDir dist.new --emptyOutDir', { cwd: clientDir, stdio: 'inherit' });

const keep = new Set([...referencedAssets(join(dist, 'index.html')), ...referencedAssets(join(next, 'index.html'))]);

mkdirSync(dist, { recursive: true });
// ① 先同步 `assets/`（新文件写入、同名覆盖）
cpSync(join(next, 'assets'), join(dist, 'assets'), { recursive: true });
// ② 其它顶层文件（favicon 等）
for (const name of readdirSync(next)) {
  if (name === 'assets' || name === 'index.html') continue;
  cpSync(join(next, name), join(dist, name), { recursive: true });
}
// ③ **最后**换指针
cpSync(join(next, 'index.html'), join(dist, 'index.html'));

// ④ 清两代之前的资源
let removed = 0;
for (const name of readdirSync(join(dist, 'assets'))) {
  if (keep.has(`assets/${name}`)) continue;
  rmSync(join(dist, 'assets', name), { recursive: true, force: true });
  removed += 1;
}
rmSync(next, { recursive: true, force: true });

// eslint-disable-next-line no-undef -- Node 脚本：只往 stdout 打一行进度（eslint 未声明 node globals）
console.log(
  `[build-atomic] 已切换：index.html → 新构建；保留 ${keep.size} 项资源，清理 ${removed} 个旧文件` +
    (existsSync(join(dist, 'index.html')) ? `（index.html ${statSync(join(dist, 'index.html')).size} B）` : ''),
);
