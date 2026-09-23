/**
 * 文档一致性检查：链接与锚点、标题层级、mermaid 结构，
 * 以及文档里对模块 / 令牌 / 类名 / 标识符的引用是否仍然存在于代码中（防止文档腐化）。
 *
 * 用法：node tests/check-docs.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['readme.md', 'docs/arch.md', 'docs/api.md', 'docs/ui.md'];
const bad = [];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripFences = (text) => text.replace(/^```[\s\S]*?^```/gm, '');
const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5 -]/g, '')
    .trim()
    .replace(/\s+/g, '-');

/* ---------- 1. 链接与锚点 ---------- */
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  const text = read(rel);
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const [filePart, anchor] = target.split('#');
    const resolved = path.resolve(path.dirname(abs), filePart);
    if (!fs.existsSync(resolved)) {
      bad.push(`${rel} -> 文件不存在: ${target}`);
      continue;
    }
    if (anchor && filePart.endsWith('.md')) {
      const anchors = [...read(path.relative(ROOT, resolved)).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]));
      if (!anchors.includes(anchor)) bad.push(`${rel} -> 锚点不存在: ${target}`);
    }
  }
}

/* ---------- 2. 标题层级（排除代码块） ---------- */
for (const rel of files) {
  const heads = [...stripFences(read(rel)).matchAll(/^(#{1,6})\s+\S/gm)].map((m) => m[1].length);
  let prev = 0;
  for (const level of heads) {
    if (prev && level > prev + 1) bad.push(`${rel} 标题层级跳跃: ${prev} -> ${level}`);
    prev = level;
  }
}

/* ---------- 3. mermaid 结构 ---------- */
for (const rel of files) {
  const lines = read(rel).split('\n');
  let block = null;
  let count = 0;
  lines.forEach((line, index) => {
    if (!block && /^\s*```mermaid/.test(line)) {
      block = { start: index + 1, lines: [] };
      return;
    }
    if (block && /^\s*```\s*$/.test(line)) {
      count += 1;
      const openSub = block.lines.filter((l) => /^\s*subgraph\b/.test(l)).length;
      const ends = block.lines.filter((l) => /^\s*end\s*$/.test(l)).length;
      const alt = block.lines.filter((l) => /^\s*(alt|opt|loop|par|critical)\b/.test(l)).length;
      const note = block.lines.filter((l) => /^\s*note\b/.test(l)).length;
      const endNote = block.lines.filter((l) => /^\s*end note\s*$/.test(l)).length;
      if (openSub && openSub !== ends) bad.push(`${rel}:${block.start} subgraph/end 不平衡 (${openSub}/${ends})`);
      if (alt && alt !== ends) bad.push(`${rel}:${block.start} alt/end 不平衡 (${alt}/${ends})`);
      if (note !== endNote) bad.push(`${rel}:${block.start} note/end note 不平衡 (${note}/${endNote})`);
      if (!/^\s*(flowchart|graph|sequenceDiagram|stateDiagram-v2|classDiagram|erDiagram)/.test(block.lines[0] ?? '')) {
        bad.push(`${rel}:${block.start} 首行不是合法图表类型: ${block.lines[0]}`);
      }
      block = null;
      return;
    }
    if (block) block.lines.push(line);
  });
  const fences = (read(rel).match(/^```/gm) || []).length;
  if (fences % 2) bad.push(`${rel} 代码围栏不成对(${fences})`);
  console.log(`${rel.padEnd(14)} mermaid=${count} 代码围栏=${fences}`);
}

/* ---------- 4. 文档对代码的引用仍然有效 ---------- */
const allCss = ['theme.css', 'base.css', 'components.css']
  .map((f) => fs.readFileSync(`${ROOT}/src/web/css/${f}`, 'utf8'))
  .join('\n');
const definedTokens = new Set([...allCss.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
const jsDir = `${ROOT}/src/web/js`;
const jsFiles = new Set(fs.readdirSync(jsDir));
const jsAll = [...jsFiles].map((f) => fs.readFileSync(`${jsDir}/${f}`, 'utf8')).join('\n');
const cssAll = ['theme.css', 'base.css', 'components.css']
  .map((f) => fs.readFileSync(`${ROOT}/src/web/css/${f}`, 'utf8'))
  .join('\n');

const TOKEN_PREFIX = /^--(background|foreground|card|muted|accent|border|input|ring|primary|status|toast|page|code|radius|font|text|space|shell|sidebar|header)/;
// 这些写法出现在文档里但不是 CSS 类：BEM 命名法示例、文件扩展名、IDL 属性名
// （扩展名必须豁免：说明文档里大量出现「`.md` 结尾」这类说法，它不是类名）
const BEM_PLACEHOLDER = new Set([
  'block',
  'block__element',
  'block__element--mod',
  'block--modifier',
  'env',
  'hidden',
  'md',
  'json',
  'log',
  'yml',
  'yaml',
  'js',
  'mjs',
  'svg',
  'html',
  'css',
  'bak',
]);
const proseOf = (rel) => stripFences(read(rel));

for (const rel of files) {
  const prose = proseOf(rel);
  // 4.1 引用的 web 模块必须存在（只认 js/xxx.js 这类写法）
  for (const [, file] of read(rel).matchAll(/(?:js\/)([\w-]+\.js)/g)) {
    if (!jsFiles.has(file)) bad.push(`${rel} -> 引用了不存在的模块 js/${file}`);
  }
  // 4.2 正文里提到的设计令牌必须已定义（跳过 `--status-*` 这类通配写法）
  for (const [, token] of prose.matchAll(/(--[\w-]+)(?![\w*-])/g)) {
    if (!TOKEN_PREFIX.test(token)) continue;
    if (!definedTokens.has(token)) bad.push(`${rel} -> 引用了不存在的令牌 ${token}`);
  }
  // 4.3 正文里点名的类名必须存在（跳过 BEM 命名法示例里的占位符）
  for (const [, cls] of prose.matchAll(/`\.([a-z][\w-]*(?:__[\w-]+)?(?:--[\w-]+)?)`/g)) {
    if (BEM_PLACEHOLDER.has(cls)) continue;
    if (!cssAll.includes(`.${cls}`)) bad.push(`${rel} -> 引用了不存在的类 .${cls}`);
  }
}
// 4.4 文档中作为「导出/函数」出现的标识符必须在代码里存在
const IDENTIFIERS = [
  'fromTemplate', 'createEmpty', 'statusLabel', 'STATUS_LABELS', 'renderTree', 'renderDetail',
  'showAlert', 'dismissAlert', 'cloneTemplate', 'setText', 'setTitle', 'toggleHidden', 'isHidden',
  'debounce', 'isInteractiveTarget', 'createThemeManager', 'ACCENTS', 'MODE_LABELS', 'ACCENT_LABELS',
  'appendRow', 'renderValue', 'RENDER_RULES', 'valueStatus', 'valueLink', 'valueMuted', 'valueJson',
  'valueChunks', 'valueText', 'sha256Hex', 'isDigestSupported', 'verifyDigest', 'resolvePermission',
  'INDEX_SRV_SECRET',
  'cacheDom', 'loadNav', 'syncThemeUi', 'normalizeSite', 'normalizeAttributes', 'SITE_STATUSES',
  'renderPermission', 'permissionFlags',
  'combineSections', 'createIndex', 'countInIndex', 'normalizeSettings', 'snapshot',
  'createDraft', 'createJsonEditor', 'validateDraft', 'formatDraft', 'isSiteField', 'SITE_FIELDS',
  'renderIntro', 'renderIntroNav', 'normalizeServiceSchema', 'DEFAULT_SERVICE_SCHEMA',
];
// 已移除的写法：文档里若再次出现，说明文档腐化
const RETIRED = [
  'valueTags', 'valueMono', 'valueAttribute', 'kv__tags', '.tag',
  'x-api-token', 'INDEX_SRV_TOKEN', 'tokenRequired', 'setToken', 'getToken', 'auth.token',
  'perm-form', 'secret key', 'index-srv:token',
  // 删除能力已整体移除：文档里不得再出现删除接口/方法
  'deleteSite', 'deleteNamespace', 'DELETE /api',
];
const codeAll = `${jsAll}\n${['src/core/schema.js', 'src/core/store.js']
  .map((rel) => fs.readFileSync(`${ROOT}/${rel}`, 'utf8'))
  .join('\n')}`;
for (const rel of files) {
  const text = read(rel);
  for (const name of IDENTIFIERS) {
    if (!text.includes(name)) continue;
    if (!codeAll.includes(name)) bad.push(`${rel} -> 提到了已不存在的标识符 ${name}`);
  }
  for (const name of RETIRED) {
    if (text.includes(name)) bad.push(`${rel} -> 仍在使用已移除的写法 ${name}`);
  }
}
// 4.5 反向：代码里的 web 模块都应在文档中被登记
const docsAll = files.map(read).join('\n');
for (const file of jsFiles) {
  if (!docsAll.includes(file)) bad.push(`模块 ${file} 未在文档中登记`);
}

/* ---------- 4.9 环境变量：代码读取的必须在文档登记，且前缀统一 ---------- */
// 命名统一为 INDEX_SRV_*（含服务密钥）。每个被代码读取的变量都要能在文档里找到，
// 否则「改了代码忘了文档」会长期潜伏 —— 服务密钥的旧前缀 INDEX_SERVICE_ 就是这样残留的。
// 只扫服务端源码（不扫测试）：测试里也会出现这些名字，否则永远命中、检查形同虚设。
const serverSrc = ['core/config.js', 'core/logger.js', 'server.js', 'core/static.js']
  .map((rel) => fs.readFileSync(`${ROOT}/src/${rel}`, 'utf8'))
  .join('\n');
const envVars = [
  ...new Set(
    [...serverSrc.matchAll(/env\('(INDEX_[A-Z_]+)'\)|process\.env\.(INDEX_[A-Z_]+)/g)].flatMap((m) =>
      m.slice(1).filter(Boolean),
    ),
  ),
];
for (const name of envVars) {
  if (!name.startsWith('INDEX_SRV_')) bad.push(`环境变量 ${name} 未使用统一的 INDEX_SRV_ 前缀`);
  if (!docsAll.includes(name)) bad.push(`代码读取了环境变量 ${name}，但文档里没有登记`);
}

/* ---------- 5. 数据分区：代码声明与文档登记必须一致 ---------- */
const storeSrc = fs.readFileSync(`${ROOT}/src/core/store.js`, 'utf8');
const declaredSectionFiles = [...storeSrc.matchAll(/file:\s*'([\w.]+\.json)'/g)].map((m) => m[1]);
for (const rel of ['conf/settings.json', 'section/namespace.json', 'section/service.json']) {
  if (!declaredSectionFiles.includes(rel.split('/')[1])) {
    bad.push(`core/store.js 未把 ${rel} 登记为分区文件`);
  }
  if (!docsAll.includes(rel)) bad.push(`数据分区文件 ${rel} 未在文档中登记`);
}

// 新建服务的草稿骨架是配置类文件（不属于 store 分区），同样要求「代码里声明 + 文档里登记」
if (!fs.readFileSync(`${ROOT}/src/config/default.json`, 'utf8').includes('serviceSchemaFile')) {
  bad.push('src/config/default.json 未登记 serviceSchemaFile');
}
if (!docsAll.includes('conf/service.schema.json')) {
  bad.push('草稿骨架文件 conf/service.schema.json 未在文档中登记');
}

console.log(bad.length ? `\n✘ ${bad.length} 项问题:\n - ${bad.join('\n - ')}` : '\n✔ 文档检查全部通过');
process.exit(bad.length ? 1 : 0);
