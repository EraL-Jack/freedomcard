import { describe, expect, it } from 'vitest';

import { cacheControlFor, isSpaRoute } from './static-serve.js';

/**
 * 静态托管的两条判定（issue #107 / D-273）。
 *
 * Era 2026-10-21 的手机上「样式没了」：刷新后恢复，说明不是构建坏了 ——
 * 是**缺资源时服务端回了 `200 + index.html`**，浏览器按 MIME 拒绝解析、静默降级，
 * 页面上什么都看不出来。所以这两条判定必须钉死：
 *  ① 只有「像前端路由」的路径才回 index.html；哈希资源一律 404；
 *  ② 带哈希的资源长缓存（immutable），index.html 不缓存 —— 否则每次打开都要
 *     重新校验 39 kB CSS + 407 kB JS，穿过隧道多一次失败机会。
 */
describe('SPA 回退范围（issue #107）', () => {
  it('前端路由回 index.html', () => {
    expect(isSpaRoute('/')).toBe(true);
    expect(isSpaRoute('/room/ABCDEF')).toBe(true);
    expect(isSpaRoute('/table')).toBe(true);
    expect(isSpaRoute('/a/b/c')).toBe(true);
    expect(isSpaRoute('/room/ABC?x=1#y')).toBe(true);
  });

  it('哈希资源 / 带扩展名的路径绝不回 index.html', () => {
    expect(isSpaRoute('/assets/index-DssWLm9t.css')).toBe(false);
    expect(isSpaRoute('/assets/index-CX6IpVAt.js')).toBe(false);
    expect(isSpaRoute('/assets/')).toBe(false);
    expect(isSpaRoute('/favicon.ico')).toBe(false);
    expect(isSpaRoute('/manifest.webmanifest')).toBe(false);
    expect(isSpaRoute('/nested/dir/file.css')).toBe(false);
  });

  it('socket.io 与 health 不走 SPA 回退', () => {
    expect(isSpaRoute('/socket.io/')).toBe(false);
    expect(isSpaRoute('/health')).toBe(false);
  });
});

describe('静态资源缓存头（issue #107）', () => {
  it('带哈希的资源长缓存且 immutable', () => {
    expect(cacheControlFor('/srv/dist/assets/index-CX6IpVAt.js')).toContain('immutable');
    expect(cacheControlFor('/srv/dist/assets/index-CX6IpVAt.js')).toContain('max-age=31536000');
  });

  it('index.html 不缓存（否则发版后浏览器还在跑旧包）', () => {
    expect(cacheControlFor('/srv/dist/index.html')).toBe('no-cache');
  });

  it('其它文件不给策略（沿用 @fastify/static 默认）', () => {
    expect(cacheControlFor('/srv/dist/favicon.ico')).toBeUndefined();
  });

  it('路径分隔符两种写法都认（Windows 上构造出来的是反斜杠）', () => {
    expect(cacheControlFor('C:\\app\\client\\dist\\assets\\index-abc.css')).toContain('immutable');
  });
});
