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

### 7.1 本机常驻 + 穿透发布（Windows）

双击 `scripts\serve-public.cmd`（默认 3100，可传参 `serve-public.cmd 3200`）。
它做两件事：先 `pnpm --filter @app/client run build`，再以 `SERVE_STATIC=1` 起服务，
**同一个端口**同时提供页面与 `/socket.io` —— 所以一条隧道就够，不必开两个口。

```cmd
cd app\scripts
serve-public.cmd
```

穿透侧的硬性要求（踩过两次，务必照做）：

| 项 | 必须这样填 | 为什么 |
| --- | --- | --- |
| 本地地址 | **`127.0.0.1`** | Windows 把 `localhost` 优先解析到 IPv6 `::1`，而服务只绑 `0.0.0.0`，表现是隧道「已连接」但外网 502 |
| 本地端口 | `3100` | 与脚本默认值一致 |
| SakuraFrp 隧道类型 | **`TCP`** | `HTTP(S)` 隧道强制要求绑定自有域名，内地节点还要求已备案 |
| SakuraFrp 节点 | **非内地**（香港/日本/新加坡等） | 官方文档：TCP 隧道穿透 HTTP 应用时必须用非内地节点 |

隧道启动后控制台会输出 `节点域名:远程端口`，那就是访问入口。
自检两条命令：`curl http://127.0.0.1:3100/health` 应回 `{"ok":true,...}`；
再用手机 4G 打开隧道地址，能进主界面且出牌无延迟，才算真的通了。

> 进程与房间状态都在内存里：脚本窗口关掉、电脑重启、隧道断开，都会导致房间消失。
> 回放文件写在 `app/replays/`，但进程重启不会补写。

### 7.2 回放校验（`replay.json`）

每局结束会在 `app/replays/` 写一份 `<roomId>-<时间戳>.json`。校验一份记录能否**逐帧重放**：

```bash
cd app
pnpm --filter @app/server run replay:verify replays/<file>.json            # 只比哈希链
pnpm --filter @app/server run replay:verify replays/<file>.json --events   # 连事件序列一起比
```

退出码：`0` 完全一致 / `1` 有差异（会指出第几步、哪一步的哪个哈希） / `2` 文件不可用
（例如 D-159 之前的旧格式没有 `setup`，只能对照哈希、无法重建开局）。

⚠️ **时间源取记录里每步事件的 `at`，不能用「起点 + 步长」推算**。
`startRule` 会把 `ctx.now` 写进 `state.startedAt`，而原局用的是真实时钟；
用固定步长重放，第一步哈希就会对不上（实测踩过）。

### 7.3 运维开关：回放清理与限流（D-182）

两者都有默认值，**不配也能跑**。要调就设环境变量：

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `REPLAY_KEEP_DAYS` | `7` | 回放保留天数，更早的会被删 |
| `REPLAY_MAX_MB` | `500` | 回放目录总量上限，超出后从最旧的删 |
| `REPLAY_SWEEP_DRY_RUN` | 未设 | 设 `1` 时**只算不删**，日志里打「将删多少份 / 多少 MB」 |
| `RL_CREATE_PER_MIN` | `10` | 每连接建房次数/分钟 |
| `RL_JOIN_PER_MIN` | `20` | 每连接加入次数/分钟 |
| `RL_INTENT_PER_SEC` | `20` | 每连接 Intent 次数/秒 |
| `RL_MAX_ROOMS` | `2000` | 全局房间数上限 |
| `RL_MAX_CONNECTIONS` | `5000` | 全局连接数上限 |

行为要点：

- **清理在启动时跑一次，之后每 24 小时一次**；最近 1 小时内写过的文件**绝不删**
  （清理与落盘都是异步的，删到正在写的那份就是静默丢数据）。
- **限流按「连接」不按 IP**：走 frpc TCP 隧道时，所有公网客户端在服务端眼里都是 `127.0.0.1`，
  按 IP 罚会连坐所有朋友（`docs/20` §8.2）。将来上 VPS 直连才谈得上按 IP。
- 超限一律回人话（`操作太频繁，请等 N 秒再试`），**不断开连接** ——
  断线会让正常玩家以为是自己网掉了。

调整阈值想先看影响面时：

```bash
cd app
REPLAY_SWEEP_DRY_RUN=1 SERVE_STATIC=1 PORT=3100 pnpm --filter @app/server run start
# 日志里会有一行「回放清理（dry-run：只算不删）」带 scanned / removed / kept
```

## 8. 目录结构

```
app/
├── packages/
│   ├── shared/   # 协议与类型（client 只引 @app/shared/constants，避免把 zod 带进首屏）
│   ├── core/     # 纯函数规则引擎（无 IO / 无时钟 / 无随机源）
│   ├── server/   # Fastify + Socket.IO，权威服务端
│   └── client/   # React + Vite + Tailwind v4
├── scripts/
│   └── serve-public.cmd   # 本机常驻启动：build 客户端 + 单端口起服务（供穿透使用）
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
| `room:next-game` | C→S | — | BO3 开下一小局，**仅房主**；第 2 局换先手、**第 3 局由上一局败者先攻**（H33 / D-145） |
| `room:deck` | C→S | `{ deck: string[] }` | 准备页换卡组，**仅未开局**（BO3 局间也拒，H37）；空数组 = 回到阵营默认（D-141） |
| `room:state` | S→C | 房间视图 | 房间变化时广播（**不含 token**；卡组只给 `deckSize`） |
| `game:intent` | C→S | `Intent` | 走完整处理链：去重 → 引擎 → reduce → 哈希 → 回放 → 广播 |
| `game:events` | S→C | 处理结果 | `accepted` 广播全房；`rejected` / `dropped` 只回发送方 |
| `game:snapshot` | S→C | 状态快照 | 重连 / 开局前下发**起点状态**；客户端必须先用它建立起点，否则那一批事件会被丢弃 |
| `echo` | C→S→C | `{ message }` | 连通性自检，无业务含义（`EchoSchema` 校验；D-180 补进本表） |

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
8. **认输没有「取消」**：两段式确认（第一次点只是变红）是防误触，确认后不可撤销。
9. Tailwind 断点在 `client/src/style.css` 的 `@theme` 中定义，**没有** `tailwind.config.js`（v4 已移除）。
10. **限流阈值是经验值**（D-182）：建房 10 次/分、Intent 20 次/秒等，按「真人碰不到、脚本立刻撞墙」估算，
    尚未在真实多人负载下校准。要调就改环境变量（§7.3），不必动代码。
10. 工程内禁止使用 `xl:` / `2xl:` 变体 —— 五档断点已全部覆盖默认值。

## 11. 本轮验收清单（D-137 ~ D-149）

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

### 11.5 认输与 BO3 第 3 局（D-147 / D-145）

| 步骤 | 预期 |
| --- | --- |
| 对局中点底部「认输」 | 按钮变红并改为「确认认输（本局判负）」，**不会立刻生效** |
| 再点一次 | 本局结束：认输方显示「本局败北」，对手显示「本局胜利」 |
| BO1 认输 | 直接显示「败北」并结束，没有「开始下一局」 |
| BO3 第 1 局认输（房主认输也算） | 出现「开始第 2 局」；点它进入第 2 局 |
| BO3 打到 1:1 后点「开始第 3 局」 | 第 3 局的**先手是第 2 局的败者**：先手方起手 5 张、后手 6 张 |
| 点「离开」 | 与认输不同：**判负整个系列赛**，不会再有下一局 |
| **待定选择浮层弹出时**（学徒冻结 / 焚典选牌等）点「认输」 | **可以点**（操作区压在浮层之上）；此时「推进阶段」「结束回合」不显示，因为它们必然被拒 |

### 11.6 展示区（D-149 / D-151）

| 步骤 | 预期 |
| --- | --- |
| 星轨 ≥3 层时点「攻击并展示」 | 双方半场的**展示区**各出现对应的卡（我方亮出，对手能看到） |
| 观察翻牌过程 | 卡**逐张**出现（每张约 0.18s），不是整批同时冒出来 |
| 观察展示区的卡 | 至少停留约 0.9s 后才归位；「展示时」效果（抽牌 / 打点 / 星轨 +1）在这段时间里结算，卡片不会闪一下就没了 |
| 结算结束 | 展示区的卡消失，日志不出现「展示区 → 卡组区」这类位移行，牌库底就是那几张（按翻开顺序） |
| 展示批次里有「展示时：抽 1 张」（守卫 / 星轨环） | 抽到的是**下一张**，不会把同批展示的卡抽进手牌 |
| 焚典 / 号令这类「看一眼但不离场」的翻牌 | 仍然显示在展示区（客户端回执），翻开后立刻归位，日志只写「展示：X」 |

> 若某项与预期不符，记下「阵营 + 卡名 + 第几回合 + 你点了什么」，比截图更好定位。
