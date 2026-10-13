# 运行说明（D-106，骨架版）

## 1. 环境要求

| 项 | 版本 | 备注 |
| --- | --- | --- |
| Node.js | `>=22.12.0` | 本机实测 22.22.2 与 24.14.0 均可 |
| pnpm | `12.11.2` | 由根 `package.json` 的 `packageManager` 锁定 |

> ⚠️ **不要用 pnpm 10 的写法去配置构建脚本白名单**。pnpm 12 的键名是 `allowBuilds`（写在 `pnpm-workspace.yaml`），
> pnpm 10 的 `onlyBuiltDependencies` 已失效 —— 写了不报错，但 `pnpm install` 仍以 `exit=1` 结束。

## 2. 安装

```bash
cd app
pnpm install
```

安装必须返回 `exit=0`。若出现 `ERR_PNPM_IGNORED_BUILDS`：

```bash
pnpm approve-builds --all   # 非交互，自动把待批准清单写进 pnpm-workspace.yaml
pnpm install
```

## 3. 启动（开发态）

```bash
pnpm dev          # 同时起 server(3000) 与 client(5173)
```

- 客户端：<http://localhost:5173>
- 服务端直连：<http://localhost:3000/health> → `{"ok":true,"version":"0.1.0"}`

客户端通过 Vite 代理访问 `/health` 与 `/socket.io`，因此页面与服务端**同源**，无需处理 CORS。

## 4. 局域网联机测（手机同 WiFi）

```bash
pnpm --filter @app/client run dev   # vite 已开 host: true
```

手机浏览器访问 `http://<本机IP>:5173`（本机实测 IP `192.168.31.153`）。
Windows 需放行 5173 / 3000 端口的入站规则（网络配置文件为 Public 时默认拦截）。

## 5. 常用脚本

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 并行起服务端与客户端 |
| `pnpm typecheck` | 全量 `tsc --noEmit` |
| `pnpm lint` | ESLint（flat config） |
| `pnpm test` | 单测（当前只有 `core/rng`） |
| `pnpm build` | 构建客户端到 `packages/client/dist` |

## 6. 生产形态

```bash
pnpm build
cd packages/server && SERVE_STATIC=1 pnpm start
```

`SERVE_STATIC=1` 时服务端托管 `client/dist`，并对未命中的 GET 回退到 `index.html`（SPA 路由）。
缺省不启用，开发态由 Vite 提供页面。

## 7. Docker 部署

```bash
docker compose up -d --build
```

⚠️ **`docker-compose.yml` 与 `Dockerfile` 未经本机验证** —— 本机无 Docker / WSL，属留档件。
真实验证须在云主机上进行，测试报告中该项必须标注「本机未验证」。

公网部署需自行提供 Nginx 配置：反代 `/socket.io` 时必须透传 `Upgrade` 与 `Connection` 头，否则 WebSocket 会退化成轮询。

## 8. 目录结构

```
app/
├── packages/
│   ├── shared/   # 协议与类型（client 只引 @app/shared/constants，避免把 zod 带进首屏）
│   ├── core/     # 纯函数规则引擎（无 IO / 无时钟 / 无随机源）
│   ├── server/   # Fastify + Socket.IO，权威服务端
│   └── client/   # React + Vite + Tailwind v4
├── Dockerfile
└── docker-compose.yml
```

## 9. 房间接口（Socket.IO）

会话层已实现**与玩法无关**的那部分（房间 / 席位 / 去重 / 重连 / 回放）。事件名常量在
`packages/shared/src/constants.ts` 的 `SOCKET_EVENTS`，禁止在业务代码里写字面量。

| 事件 | 方向 | payload | 说明 |
| --- | --- | --- | --- |
| `room:create` | C→S | `{ nickname, capacity }` | 建房。**不预设人数**，`capacity` 由调用方给 |
| `room:join` | C→S | `{ code, nickname }` | 加入；满员返回 `ROOM_FULL` |
| `room:reconnect` | C→S | `{ playerId, token }` | 断线重连；返回快照（含 `lastSeqByPlayer`） |
| `room:leave` | C→S | — | 主动离开；房主离开则移交房主 |
| `room:state` | S→C | 房间视图 | 房间变化时广播（**不含 token**） |
| `game:intent` | C→S | `Intent` | 走完整处理链：去重 → 引擎 → reduce → 哈希 → 回放 → 广播 |
| `game:events` | S→C | 处理结果 | `accepted` 广播全房；`rejected` / `dropped` 只回发送方 |

要记住的三条：

1. **客户端须保存 `playerId` 与 `token`** —— 重连全靠它俩。
2. 重连后 **从 `lastSeq + 1` 续发** Intent，本地计数归零重来会被判 `STALE` 全部丢弃。
3. 断线席位保留 **60s（`RECONNECT_GRACE_MS`）**，超时由服务端巡检释放。

## 10. 已知限制

1. 规则引擎的 `applyIntent` / `reduce` 为 `TODO(slot)` —— 规则由 Era 在 `docs/06` A 组输入后实现，**当前不得自行补写玩法**。
   因此现在发 `game:intent` 会收到 `rejected / NOT_IMPLEMENTED` —— 这是**预期状态**，说明链路是通的、只是规则没接。
2. 房间与重连**已实现**；对战流程（开始对局、回合、胜负）仍未实现，属 `prompts/03` 且依赖 A 组输入。
3. 客户端的房间区块是**占位界面**（琥珀色，已标注），只用于联机自检 —— 布局与视觉等 Era 在 `docs/06` B 组输入后整体替换。
   **其点击流程未在本机验证**：本机无浏览器自动化工具（装 agent-browser 需拉 ~500MB Chromium）。已验证的是页面 HTTP 200、构建产物含该组件、zod 未进首屏；真实交互由 Era 在浏览器/手机上实测（`F-0001` §3.3）。
3. Tailwind 断点在 `client/src/style.css` 的 `@theme` 中定义，**没有** `tailwind.config.js`（v4 已移除）。
4. 工程内禁止使用 `xl:` / `2xl:` 变体 —— 五档断点已全部覆盖默认值。
