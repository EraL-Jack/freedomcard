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
| `pnpm test` | 单测（Vitest）：`core` 规则引擎 + `server` 会话层，2026-10-13 时点 **131 passed** |
| `pnpm build` | 构建客户端到 `packages/client/dist` |
| `pnpm --filter @app/client test:e2e` | 端到端（Playwright）：**7 条** —— 房间流程 / 视口溢出 / 联机开局 / 回合操作链路 / 攻击与指挥官伤害 |

> 首次跑 E2E 需先下载浏览器：`pnpm --filter @app/client exec playwright install chromium`（约 197 MiB，慢）。
> 截图落在 `packages/client/e2e/screenshots/`（已被 `.gitignore` 忽略）。

### 跑 E2E 的两个前置（本机 Windows 必读）

1. **先手动起服务，再跑 E2E** —— `playwright.config.ts` 里的 `webServer` 自行拉起
   `pnpm -r --parallel dev` 时**收不到就绪信号**，会卡到 timeout；但服务本身是能起来的。
   故本机改为先 `pnpm dev`，靠 `reuseExistingServer` 复用已跑着的服务：

   ```bash
   pnpm dev &                              # 或另开一个终端
   pnpm --filter @app/client test:e2e
   ```

2. **想要确定牌序就带 `GAME_SEED`** —— 手动起服务时环境变量要自己传，
   因为复用已有服务时 `playwright.config.ts` 里的 `webServer.env` **不会生效**（ADR-0021）：

   ```bash
   GAME_SEED=20261013 pnpm dev
   ```

   生产**不要**设这个变量，否则每局牌序相同。

想只跑某一个文件：`pnpm --filter @app/client exec playwright test e2e/combat.spec.ts`

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

事件名常量在 `packages/shared/src/constants.ts` 的 `SOCKET_EVENTS`，禁止在业务代码里写字面量。

| 事件 | 方向 | payload | 说明 |
| --- | --- | --- | --- |
| `room:create` | C→S | `{ nickname, capacity, format?, faction?, deck? }` | 建房。`capacity` 由调用方给（不预设人数）；`format` = BO1/BO3；`faction` = 本方阵营；`deck` = 自建主卡组 30 个 `defId`（不传即阵营默认） |
| `room:join` | C→S | `{ code, nickname, faction?, deck? }` | 加入；满员返回 `ROOM_FULL` |
| `room:reconnect` | C→S | `{ playerId, token }` | 断线重连；返回快照（含 `lastSeqByPlayer`） |
| `room:leave` | C→S | — | 主动离开；房主离开则移交房主 |
| `room:ready` | C→S | — | 准备；满员且全员 ready → 服务端走系统 `game:start`（ADR-0019） |
| `room:next-game` | C→S | — | BO3 开下一小局，**仅房主**；第 2 局换先手、第 3 局重掷 |
| `room:deck` | C→S | `{ deck: string[] }` | 准备页换卡组，**仅未开局**；空数组 = 回到阵营默认（D-141） |
| `room:state` | S→C | 房间视图 | 房间变化时广播（**不含 token**；卡组只给 `deckSize`） |
| `game:intent` | C→S | `Intent` | 走完整处理链：去重 → 引擎 → reduce → 哈希 → 回放 → 广播 |
| `game:events` | S→C | 处理结果 | `accepted` 广播全房；`rejected` / `dropped` 只回发送方 |

要记住的三条：

1. **客户端须保存 `playerId` 与 `token`** —— 重连全靠它俩。
2. 重连后 **从 `lastSeq + 1` 续发** Intent，本地计数归零重来会被判 `STALE` 全部丢弃。
3. 断线席位保留 **60s（`RECONNECT_GRACE_MS`）**，超时由服务端巡检释放。

> ⚠️ 自建卡组的 `deck` 字段**必须在入站 schema 里显式声明**。`z.object()` 对未声明的键是
> strip，漏掉会让卡组被静默丢弃、服务端回退默认卡组，且没有任何报错。已由
> `server/src/schema.test.ts` 钉住。

## 10. 已知限制

1. **移动端未真机实测**：只做了 375 / 768 / 1440 三档视口渲染验证，触摸拖拽与安全区表现待实机确认。
2. **音效 / 卡面素材缺失**（X-15 未给）：视觉动效已先行，音效留钩子。
3. **图标与配色为占位方案**（X-14 未定）：纯色 + 文字卡。
4. **卡组允许混阵营**：三阵营 45 张同池，服务端只校验张数 / 同名 / 不含指挥官，不限制阵营纯度。
5. **准备后不能改卡组**：`room:deck` 只在 `lobby` 阶段接受；目前也没有「取消准备」入口。
6. **BO3 局间不能换卡组**：`awaitingNext` 时房间仍是 `playing`，`setDeck` 会拒 `DECK_LOCKED`。
7. **40 轮判和只在单测覆盖**：E2E 跑 80 回合成本过高。
8. Tailwind 断点在 `client/src/style.css` 的 `@theme` 中定义，**没有** `tailwind.config.js`（v4 已移除）。
9. 工程内禁止使用 `xl:` / `2xl:` 变体 —— 五档断点已全部覆盖默认值。

## 11. 本轮验收清单（D-137 ~ D-143）

按顺序点一遍即可覆盖本批全部改动。两个浏览器窗口（或两台设备）各开一个客户端。

### 11.1 卡组接入开局（D-141 / D-143）

| 步骤 | 预期 |
| --- | --- |
| 主界面点「编辑卡组」→ 新建 → 加满 30 张（同名 ≤3） | 顶部显示 `30 / 30 张`，出现「设为开局卡组」按钮 |
| 点「设为开局卡组」 | 按钮变成「开局使用中」 |
| 返回主界面 | 「我的卡组」下拉已选中这套；未满 30 张的卡组是灰的并显示 `N/30` |
| 建房 → 进准备页 | 显示「本局使用：<卡组名>」 |
| 切换下拉到「阵营默认卡组」再切回来 | 出现提示「卡组已更新」，本局使用那一行跟着变 |
| 双方准备 → 开局 | 我方牌库/手牌的卡来自这套卡组（用异阵营卡组最容易看出来） |

### 11.2 冻结口径（D-139）

| 步骤 | 预期 |
| --- | --- |
| 霜律方冻结对方一个随从（学徒/律令等） | 该随从横置并带冻结标记；霜痕 +1 |
| 对**同一个**随从再发动一次冻结类效果 | 选择浮层里**不出现**它；对方场上全被冻住时不弹选择 |
| 缚锁者登场时只能选到已冻结单位 | 走「抽 1 张」分支，不产生新的冻结与霜痕 |

### 11.3 指挥官伤害加成（D-137）

| 步骤 | 预期 |
| --- | --- |
| 星轨方指挥官点「攻击并展示（1 费）」 | 先展示、后结算伤害 |
| 展示中出现「星轨侍僧」 | 日志出现「指挥官本回合伤害 +1」，本次伤害为 2 |

### 11.4 设置法术（D-140）

| 步骤 | 预期 |
| --- | --- |
| 卡面类型徽章 | 显示「**设置**」而不是「持续」 |
| 打出炎刃战旗 / 霜律寒域 / 星轨环 | 卡留在法术区（不弃掉），效果持续生效 |
| 打出普通法术（如律令） | 结算后进弃牌区 |

> 若某项与预期不符，记下「阵营 + 卡名 + 第几回合 + 你点了什么」，比截图更好定位。
