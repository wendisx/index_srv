/**
 * 回归套件入口：依次执行各项检查并汇总结果。
 *
 * 用法：
 *   npm test                      # 全部检查
 *   node tests/check-static.mjs   # 只跑某一项（见下方 CHECKS）
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const CHECKS = [
  ['静态契约', 'check-static.mjs'],
  ['纯逻辑', 'check-logic.mjs'],
  ['渲染快照', 'check-render.mjs'],
  ['文档一致性', 'check-docs.mjs'],
  ['端到端冒烟', 'check-server.mjs'],
];

const results = [];

for (const [label, file] of CHECKS) {
  process.stdout.write(`\n=== ${label} · ${file} ===\n`);
  const startedAt = Date.now();
  const { status } = spawnSync(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' });
  results.push({ label, file, code: status ?? 1, ms: Date.now() - startedAt });
}

const failed = results.filter((result) => result.code !== 0);

process.stdout.write('\n=== 汇总 ===\n');
for (const result of results) {
  process.stdout.write(
    `${result.code === 0 ? '✔' : '✘'} ${result.label}（${result.file}）  ${result.ms}ms\n`,
  );
}

if (failed.length) {
  process.stdout.write(`\n✘ ${failed.length} / ${results.length} 项未通过\n`);
  process.exit(1);
}
process.stdout.write(`\n✔ 全部 ${results.length} 项通过\n`);
