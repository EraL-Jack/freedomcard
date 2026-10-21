/**
 * 音效（P-06，Era 2026-10-21「素材先整音效吧，你来整」）。
 *
 * ## 为什么是程序化合成，不是素材文件
 *
 * X-15 的素材包还没定（风格、授权都没拍板）。用 Web Audio 现场合成有三点好处：
 * 1. **零素材体积** —— 首屏不多一个字节，也不用担心授权；
 * 2. **参数可调** —— 以后真给了音效包，换掉本文件即可，调用点（三个事件）不动；
 * 3. **不会「听起来像别的游戏」** —— 合成音是最中性的占位。
 *
 * ## 只做三条
 *
 * 打击 / 抽牌 / 结算。Era 的原话就是这三条，多做的部分（胜利 BGM、菜单音）
 * 属于素材范畴，等他给方向。
 *
 * ## 浏览器自动播放
 *
 * `AudioContext` 必须在用户手势之后才能出声。本文件的调用点全部落在
 * 「玩家点过按钮之后」（事件由操作触发），所以首次创建即有声；
 * 仍然保留 `resume()`，因为切后台回来时 ctx 可能已 suspended。
 */

const LS_MUTED = 'fc.sfxMuted';

/** 静音状态 —— 从 localStorage 初始化，避免「刷新后又开始响」。 */
let muted = ((): boolean => {
  try {
    return localStorage.getItem(LS_MUTED) === '1';
  } catch {
    return false;
  }
})();

let ctx: AudioContext | null = null;

export function isSfxMuted(): boolean {
  return muted;
}

export function setSfxMuted(value: boolean): void {
  muted = value;
  try {
    if (value) localStorage.setItem(LS_MUTED, '1');
    else localStorage.removeItem(LS_MUTED);
  } catch {
    // localStorage 不可用（隐私模式）→ 只影响「记住选择」，不影响本次会话
  }
}

/** 取（并懒建）音频上下文；环境不支持时返回 null，调用点静默跳过。 */
function ac(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return null;
  if (!ctx) {
    try {
      ctx = new window.AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** 一段衰减噪声 —— 打击与抽牌的「质感」都来自它。 */
function noiseSource(c: AudioContext, dur: number, curve: number): AudioBufferSourceNode {
  const buf = c.createBuffer(1, Math.max(1, Math.ceil(c.sampleRate * dur)), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    // 线性白噪 × 衰减包络：`curve` 越大，尾巴收得越急（打击感更硬）
    const env = Math.pow(1 - i / data.length, curve);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  return src;
}

/**
 * 打击 —— 噪声爆 + 低频下坠。
 *
 * @param strength 伤害点数（1~3），决定音量与下坠深度；夹到 [0.6, 1.6] 免得
 *                 3 点伤害炸耳朵、0 点伤害听不见。
 */
function hit(strength = 1): void {
  if (muted) return;
  const c = ac();
  if (!c) return;
  const s = Math.min(1.6, Math.max(0.6, 1 + (strength - 1) * 0.3));
  const t0 = c.currentTime;

  const src = noiseSource(c, 0.14, 2);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 900;
  bp.Q.value = 0.7;
  const ng = c.createGain();
  ng.gain.value = 0.32 * s;
  src.connect(bp).connect(ng).connect(c.destination);
  src.start(t0);

  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(170, t0);
  osc.frequency.exponentialRampToValueAtTime(52, t0 + 0.18);
  const og = c.createGain();
  og.gain.setValueAtTime(0.42 * s, t0);
  og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
  osc.connect(og).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + 0.22);
}

/** 抽牌 —— 一层高频摩擦噪声 + 轻微上扫，短促不抢戏。 */
function draw(): void {
  if (muted) return;
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime;

  const src = noiseSource(c, 0.1, 3);
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2200;
  const ng = c.createGain();
  ng.gain.value = 0.12;
  src.connect(hp).connect(ng).connect(c.destination);
  src.start(t0);

  const osc = c.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(460, t0);
  osc.frequency.linearRampToValueAtTime(920, t0 + 0.1);
  const og = c.createGain();
  og.gain.setValueAtTime(0.001, t0);
  og.gain.linearRampToValueAtTime(0.07, t0 + 0.03);
  og.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
  osc.connect(og).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + 0.13);
}

/**
 * 结算 —— 三个音一组的短和弦。
 *
 * 胜：大三和弦往上（C-E-G）；负：同样的三个音倒着走 + 降一个八度感。
 * 不引旋律、不做长尾：这只是「对局结束了」的听觉句号，不是 BGM。
 */
function end(win: boolean): void {
  if (muted) return;
  const c = ac();
  if (!c) return;
  const notes = win ? [523.25, 659.25, 783.99] : [392.0, 329.63, 261.63];
  const t0 = c.currentTime;
  notes.forEach((f, i) => {
    const at = t0 + i * 0.12;
    const osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = f;
    const g = c.createGain();
    g.gain.setValueAtTime(0.001, at);
    g.gain.linearRampToValueAtTime(0.16, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.34);
    osc.connect(g).connect(c.destination);
    osc.start(at);
    osc.stop(at + 0.36);
  });
}

export const sfx = { hit, draw, end } as const;
