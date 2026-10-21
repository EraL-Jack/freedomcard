import { defineConfig } from 'vitest/config';

/**
 * client 单测配置（T-04）。
 *
 * ## 为什么只测纯逻辑，不测组件
 *
 * 组件测试要引 jsdom + testing-library，成本立刻上一个量级，而且判据本身
 * 已经在 `selectors.ts` / `labels.ts` / `log.ts` 里了 —— 给纯函数写测试，
 * 命中率比「渲染一遍再 assert 文案」高得多。
 *
 * 环境固定 `node`：被测文件不碰 DOM / localStorage，跑得也更快。
 * 哪天要测组件，把 `environment` 换成 `jsdom` 并只对那个文件生效即可。
 *
 * ## 覆盖率
 *
 * `pnpm --filter @app/client run test:coverage` 出覆盖率。
 * `include` 只收 `src/**`，`exclude` 掉测试自身与入口 —— 把 `main.tsx`
 * 算进分母只会让数字永远难看，它对逻辑覆盖没有意义。
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/main.tsx', 'src/types.ts', 'src/socket.ts'],
    },
  },
});
