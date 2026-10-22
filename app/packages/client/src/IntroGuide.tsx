import { useState } from 'react';

/**
 * 分步引导（P-03，Era 2026-10-21「P03 用 1 方案」；D-292 重排为四步）。
 *
 * ## 为什么是浮层而不是「怎么玩」页面
 *
 * 新手的真实卡点不在规则全貌，而在**第一次进对战桌不知道手该点哪里**。
 * 把每一步贴在操作现场，比另开一页图文有效得多（docs/21 P-03 的选项①）。
 *
 * ## 第一步为什么是「换牌」而不是「充能」（issue #117）
 *
 * 引导上线时开局还直接进第一回合，第一件事就是充能。换牌阶段（D-259）是后来才加的，
 * 加在**一切之前** —— 于是引导的第一句话指向了一个此刻不存在的按钮
 * （顶栏写着「阶段 换牌」，桌面上没有充能入口）。首次进桌是唯一一次能看到引导的时机，
 * 这一步错位等于引导整体失效。
 *
 * 现在的顺序严格跟随玩家实际要走的流程：换牌 → 充能 → 推进 → 出牌。
 * 原「推进阶段」那一步**保留** —— 它是第二个卡点（抽牌阶段要手点卡组），
 * 为凑三步而删掉它会换一个坑。
 *
 * ## 只出现一次
 *
 * 看过就写 `localStorage`，刷新不再弹。没看完（直接刷新）不算看过 ——
 * 写入时机是**点完最后一步**，不是打开浮层。
 *
 * ## 文案为什么这么写
 *
 * 每步只讲「现在该做什么」，不解释战术。规则细节（前排、力量裁决）
 * 留给卡面与 `docs/16`，塞进引导只会让人在第一分钟就跑。
 */

/** 已看过引导的标记。E2E 会预置它，避免浮层挡住操作。 */
export const INTRO_SEEN_KEY = 'fc.introSeen';

const STEPS: readonly { title: string; body: string }[] = [
  {
    title: '① 先换牌',
    body: '开局停在换牌阶段：点手牌里不想要的（可以多选）→ 点「确认换牌」；不想换就直接点「不换牌」。双方都确认后才进第一回合，倒计时走完会替你按「不换牌」开局。',
  },
  {
    title: '② 充能',
    body: '充能阶段：点一张手牌 → 点「充能」（也可以直接把它拖进费用区）。充能进来的牌就是本回合能用掉的费用。',
  },
  {
    title: '③ 推进阶段',
    body: '每回合按 充能 → 重置 → 抽牌 → 主要 → 战斗 → 结束 走，不能跳。点「推进阶段」一格一格走；到抽牌阶段要手动点一下卡组才能抽牌。',
  },
  {
    title: '④ 出牌与攻击',
    body: '主要阶段：点一张手牌 → 点「出牌」。随从没有生命值，战斗只比力量，高的一方活下来。战斗阶段点自己的随从，再点对手的单位或指挥官就能攻击。',
  },
];

export default function IntroGuide(props: { onDone: () => void }): React.JSX.Element {
  const [step, setStep] = useState(0);
  const last = step >= STEPS.length - 1;
  const cur = STEPS[step]!;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4"
      data-testid="intro-guide"
    >
      <div className="w-full max-w-sm rounded-xl border border-slate-600 bg-slate-900 p-4 text-left">
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-400">
            新手引导 {step + 1}/{STEPS.length}
          </p>
          {/* 命中区 ≥ 44×44（issue #118 / D-292）——
              原来只有「跳过」两个字的自然尺寸 24×16，没有 padding，手机上点不中。
              视觉上仍是一个小号文字按钮，靠 `min-h-11 min-w-11` 把**可点范围**撑开；
              `-mr-2` 抵消内边距，让它看起来仍贴着卡片右上角。 */}
          <button
            type="button"
            className="-mr-2 flex min-h-11 min-w-11 items-center justify-center rounded px-2 text-xs text-slate-400 underline hover:bg-slate-800 hover:text-slate-200"
            onClick={props.onDone}
            aria-label="跳过新手引导"
            data-testid="intro-skip"
          >
            跳过
          </button>
        </div>

        <p className="mt-2 text-base font-medium text-amber-200" data-testid="intro-title">
          {cur.title}
        </p>
        <p className="mt-2 min-h-20 text-sm leading-relaxed text-slate-200" data-testid="intro-body">
          {cur.body}
        </p>

        <div className="mt-3 flex items-center gap-2">
          {step > 0 ? (
            <button
              type="button"
              className="rounded bg-slate-700 px-3 py-2 text-sm"
              onClick={() => setStep((s) => s - 1)}
              data-testid="intro-prev"
            >
              上一步
            </button>
          ) : null}
          <button
            type="button"
            className="ml-auto rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50"
            onClick={() => (last ? props.onDone() : setStep((s) => s + 1))}
            data-testid={last ? 'intro-done' : 'intro-next'}
          >
            {last ? '开始对战' : '下一步'}
          </button>
        </div>

        <p className="mt-3 text-[11px] text-slate-500">这段提示只出现一次；规则细节可以随时点开任意卡牌查看。</p>
      </div>
    </div>
  );
}
