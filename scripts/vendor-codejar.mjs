/**
 * 把 CodeJar 源码 vendored 进 src/web/vendor/。
 *
 * 为什么需要这个脚本：
 *   前端不做构建、运行时也不安装依赖 —— 浏览器直接加载 src/web 下的原生 ES Module，
 *   容器构建同样不需要 npm install。因此第三方浏览器库在开发期「复制」进仓库并提交，
 *   与 scripts/build-icons.mjs 生成图标精灵是同一套路。
 *
 * 用法：
 *   npm run vendor
 *
 * 更新流程：npm i -D codejar@<版本> → npm run vendor → 提交产物。
 *
 * 来源：codejar（MIT License，Copyright (c) 2020 Anton Medvedev）
 *       https://github.com/antonmedv/codejar
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = path.join(ROOT_DIR, 'node_modules', 'codejar');
const SOURCE_FILE = path.join(PACKAGE_DIR, 'dist', 'codejar.js');
const LICENSE_FILE = path.join(PACKAGE_DIR, 'LICENSE');
const OUTPUT_FILE = path.join(ROOT_DIR, 'src', 'web', 'vendor', 'codejar.js');

/** MIT 要求分发时保留版权与许可声明，因此许可证原文一并写进产物头部 */
const licenseBlock = (license) =>
  license
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? ` * ${line.trimEnd()}` : ' *'))
    .join('\n');

async function main() {
  let source;
  try {
    source = await fs.readFile(SOURCE_FILE, 'utf8');
  } catch {
    throw new Error(`未找到 ${path.relative(ROOT_DIR, SOURCE_FILE)}，请先执行：npm install`);
  }

  const { version } = JSON.parse(await fs.readFile(path.join(PACKAGE_DIR, 'package.json'), 'utf8'));
  const license = await fs.readFile(LICENSE_FILE, 'utf8');

  const header = [
    '/**',
    ` * CodeJar ${version} —— 轻量级 contenteditable 代码编辑器（原生 ES Module）。`,
    ' * 本文件由 scripts/vendor-codejar.mjs 从 node_modules 复制生成，请勿手工编辑。',
    ' * 重新生成：npm run vendor',
    ' * 源码：https://github.com/antonmedv/codejar',
    ' *',
    licenseBlock(license),
    ' */',
    '',
  ].join('\n');

  const output = `${header}${source}`;
  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, output, 'utf8');

  process.stdout.write(
    `已生成 ${path.relative(ROOT_DIR, OUTPUT_FILE)}：codejar@${version}，${Buffer.byteLength(output)} 字节\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`生成失败：${error.message}\n`);
  process.exit(1);
});
