/**
 * 由 lucide-static 生成 SVG 图标精灵。
 *
 * 为什么需要这个脚本：
 *   项目运行时不引入任何 npm 包（浏览器直接加载源码、镜像无需 npm install），
 *   因此把 lucide 的图标在开发期「编译」成一个 sprite.svg 并提交到仓库，
 *   页面通过 <use href="./icons/sprite.svg#名称"> 引用。
 *
 * 用法：
 *   npm run icons                  # 生成 src/web/icons/sprite.svg
 *
 * 新增图标：
 *   1. 把 lucide 图标名（kebab-case，见 https://lucide.dev/icons）加入下方 MANIFEST；
 *   2. 执行 npm run icons；
 *   3. 在 HTML/JS 中用 <use href="./icons/sprite.svg#<名称>"> 引用。
 *
 * 图标来源：lucide-static（ISC License）
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 页面实际用到的图标，保持最小集合 */
const MANIFEST = [
  'monitor', // 模式：跟随系统
  'sun', // 模式：浅色
  'moon', // 模式：深色
  'refresh-cw', // 刷新
  'external-link', // 详情外链标识
  'chevron-right', // 目录树展开指示（展开时 CSS 旋转 90 度）
  'plus', // 新建命名空间 / 添加服务（仅 super 可见）
  'pencil', // 编辑服务（仅 super 可见）
  'check', // 编辑器：保存
  'x', // 编辑器：取消
  'rotate-ccw', // 编辑器：重置为初始内容
  'book-open', // 页头：说明文档入口
  'info', // 提示：信息
  'circle-check', // 提示：成功
  'triangle-alert', // 提示：警告
  'circle-alert', // 提示：错误
];

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = path.join(ROOT_DIR, 'node_modules', 'lucide-static');
const ICON_DIR = path.join(PACKAGE_DIR, 'icons');
const OUTPUT_FILE = path.join(ROOT_DIR, 'src', 'web', 'icons', 'sprite.svg');

/** 样式属性写在 <symbol> 上，由 <use> 继承，保证 currentColor 与线宽一致 */
const SYMBOL_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round"';

async function readPackageVersion() {
  try {
    const raw = await fs.readFile(path.join(PACKAGE_DIR, 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 取出 <svg> 内部内容并统一缩进，保证输出稳定可复现 */
function extractShapes(svgSource, name) {
  const matched = svgSource.match(/<svg[^>]*>([\s\S]*)<\/svg>/);
  if (!matched) {
    throw new Error(`图标 ${name}.svg 结构异常：未找到 <svg> 内容`);
  }
  const shapes = matched[1]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (shapes.length === 0) {
    throw new Error(`图标 ${name}.svg 为空`);
  }
  return shapes.map((line) => `    ${line}`).join('\n');
}

async function main() {
  try {
    await fs.access(ICON_DIR);
  } catch {
    throw new Error(
      `未找到 ${path.relative(ROOT_DIR, ICON_DIR)}，请先执行：npm install`,
    );
  }

  const version = await readPackageVersion();
  const symbols = [];

  for (const name of MANIFEST) {
    const file = path.join(ICON_DIR, `${name}.svg`);
    let source;
    try {
      source = await fs.readFile(file, 'utf8');
    } catch {
      throw new Error(
        `图标 ${name} 不存在于 lucide-static@${version}，请核对名称：https://lucide.dev/icons`,
      );
    }
    symbols.push(`  <symbol id="${name}" ${SYMBOL_ATTRS}>\n${extractShapes(source, name)}\n  </symbol>`);
  }

  const header = [
    '<!--',
    '  本文件由 scripts/build-icons.mjs 自动生成，请勿手工编辑。',
    `  图标来源：lucide-static@${version}（ISC License，https://lucide.dev）`,
    `  重新生成：npm run icons`,
    '-->',
  ].join('\n');

  const sprite = `${header}\n<svg xmlns="http://www.w3.org/2000/svg">\n${symbols.join('\n')}\n</svg>\n`;

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, sprite, 'utf8');

  const bytes = Buffer.byteLength(sprite);
  process.stdout.write(
    `已生成 ${path.relative(ROOT_DIR, OUTPUT_FILE)}：${MANIFEST.length} 个图标，${bytes} 字节\n` +
      `  lucide-static@${version} → ${MANIFEST.join(', ')}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`生成失败：${error.message}\n`);
  process.exit(1);
});
