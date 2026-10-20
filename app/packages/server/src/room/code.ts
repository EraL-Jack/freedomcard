import { randomInt } from 'node:crypto';

/**
 * 房间码生成（D-178）。
 *
 * ## 为什么要单独抽出来
 *
 * 原来的实现是 `Math.random().toString(36).slice(2, 8).toUpperCase()`，两个问题：
 *
 * 1. **`Math.random()` 不是密码学安全的随机源** —— 它的输出序列可被推算，
 *    而房间码是加入房间的**唯一凭证**（本作没有账号体系）。能推算 = 能猜别人的房间。
 * 2. **字符集里混着 `0/O`、`1/I`** —— 房间码要口头念给朋友，这几个字符听错就进不去，
 *    而且报错只说「房间不存在」，玩家会以为是对方建错了。
 *
 * 现在用 `crypto.randomInt` + 32 字符表（去掉 0/O/1/I），长度固定 6。
 * 空间 32^6 ≈ 10.7 亿，配合服务端的碰撞重试足够。
 *
 * ⚠️ 改字符集会让**旧房间码**（含被去掉的字符）变得无法通过前端校验 ——
 * 但房间只存在内存里，服务重启即失效，所以不构成兼容问题。
 */

/** 32 个字符，去掉 `0 O 1 I` 这类易混项。 */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 房间码长度。前端校验正则按 `{4,8}` 放宽，这里固定 6。 */
export const ROOM_CODE_LENGTH = 6;

/** 生成一个房间码。 */
export function makeRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return code;
}
