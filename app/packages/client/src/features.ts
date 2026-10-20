/**
 * 客户端功能开关（D-183）。
 *
 * ## 为什么要有这个文件
 *
 * 「回放观看」在服务端一直是可用的（每间房销毁时落一份 `replay.json`，见
 * `server/src/room/replay.ts`），但**观看**要真把文件传到浏览器 —— 公网走的是
 * SakuraFrp 隧道，Era 2026-10-20：**每月流量有限**。先把入口置灰，别让一次
 * 好奇点击烧掉配额。
 *
 * ## 关的是入口，不是记录
 *
 * 服务端记录链路（`Intent → 回放 → 落盘`）**一行都没改**，`app/replays/` 里的
 * 文件照常产生。所以将来把下面的开关改成 `true` 就能直接看历史对局，不需要补数据。
 *
 * ## 公网也拿不到
 *
 * 只置灰按钮是不够的，还得确认没有旁路：静态服务根目录是 `client/dist`
 * （`server/src/index.ts` 的 `CLIENT_DIST`），`app/replays/` 在它之外；
 * 服务端也没有任何 HTTP 路由读回放 —— 唯一入口是本地 CLI
 * `pnpm --filter @app/server run replay:verify <文件>`（看的是操作者自己的磁盘）。
 */

/**
 * 回放**观看**入口是否开放。
 *
 * 默认 `false`：按钮显示但置灰（`disabled`），悬浮提示说明原因。
 * 改成 `true` 只影响按钮可用性，不影响记录。
 */
export const REPLAY_VIEW_ENABLED = false;
