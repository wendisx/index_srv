/**
 * 静态契约检查：不需要运行代码，只检查「源码之间的约定」是否仍然成立。
 *
 * 覆盖：HTML/CSS 隔离、id / class / 令牌 / 图标闭环、CSS 约束与布局不变量、
 *       节点缓存选择器与页面结构匹配、ES Module 依赖分层、导入导出闭环与死导出。
 *
 * 用法：node tests/check-static.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument } from './dom-shim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'src', 'web');
const JS_DIR = path.join(WEB, 'js');
const read = (p) => fs.readFileSync(path.join(WEB, p), 'utf8');
const stripCss = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');
const stripJs = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const html = read('index.html');
const cssRaw = ['css/theme.css', 'css/base.css', 'css/components.css'].map(read).join('\n');
const css = stripCss(cssRaw);
const jsFiles = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).sort();
const src = Object.fromEntries(jsFiles.map((f) => [f, read(`js/${f}`)]));
const jsAll = Object.values(src).map(stripJs).join('\n');

const bad = [];
const notes = [];

/* ---------------- 1. HTML 与样式隔离 ---------------- */
if (/<style[\s>]/i.test(html)) bad.push('index.html 含 <style> 块');
if (/\sstyle\s*=\s*["']/i.test(html)) bad.push('index.html 含内联 style 属性');
if (/\son[a-z]+\s*=/i.test(html)) bad.push('index.html 含内联事件属性');
for (const [file, code] of Object.entries(src)) {
  if (/\.style\./.test(code)) bad.push(`${file} 直接操作了内联样式`);
  if (/innerHTML\s*=/.test(code)) bad.push(`${file} 使用了 innerHTML`);
}
if (!['css/theme.css', 'css/base.css', 'css/components.css'].every((f) => html.includes(f))) bad.push('样式未全部外链');

/* ---------------- 2. id 引用闭环 ---------------- */
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const refIds = new Set(
  [...jsAll.matchAll(/\$\('#([\w-]+)'\)|getElementById\('([\w-]+)'\)|cloneTemplate\('([\w-]+)'\)|fromTemplate\('([\w-]+)'/g)]
    .flatMap((m) => m.slice(1))
    .filter(Boolean),
);
for (const id of refIds) if (!htmlIds.has(id)) bad.push(`JS 引用了不存在的 id: #${id}`);

/* ---------------- 3. 节点缓存键闭环 ---------------- */
const domBlock = src['app.js'].match(/const DOM_SELECTORS = \{([\s\S]*?)\};/);
if (!domBlock) bad.push('app.js 未找到 DOM_SELECTORS');
else {
  const entries = [...domBlock[1].matchAll(/^\s{2}([\w]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]]);
  const declared = new Set(entries.map(([key]) => key));
  // 排除 './dom.js' 这类模块路径，只取真正的属性访问
  const usedKeys = new Set([...src['app.js'].matchAll(/(?<![./\w])dom\.([\w]+)/g)].map((m) => m[1]));
  for (const key of usedKeys) if (!declared.has(key)) bad.push(`app.js 使用了未声明的 dom.${key}`);
  for (const key of declared) if (!usedKeys.has(key)) bad.push(`DOM_SELECTORS 声明了未使用的 dom.${key}`);
  // 选择器必须真的能在 index.html 中命中元素
  const page = parseDocument(html);
  for (const [key, selector] of entries) {
    if (!page.querySelector(selector)) bad.push(`DOM_SELECTORS.${key} 的选择器 ${selector} 在 index.html 中无匹配元素`);
  }
}

/* ---------------- 4. class 契约 ---------------- */
// 类名从「去掉 url(...) 内容」的副本里提取：图片文件名里的 .jpg 不是类名
const cssForClasses = css.replace(/url\([^)]*\)/g, 'url()');
const cssClasses = new Set([...cssForClasses.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const usedClasses = new Set(
  [
    ...[...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)),
    ...[...jsAll.matchAll(/className\s*=\s*[^;\n]*?'([^']+)'/g)].flatMap((m) => m[1].split(/\s+/)),
    ...[...jsAll.matchAll(/classList\.(?:add|remove|toggle)\('([\w-]+)'/g)].map((m) => m[1]),
    ...[...jsAll.matchAll(/querySelector(?:All)?\('\.([\w-]+)/g)].map((m) => m[1]),
  ].filter((c) => c && !c.startsWith('$')),
);
for (const c of usedClasses) if (!cssClasses.has(c)) bad.push(`使用了未定义的样式类 .${c}`);
// 定义了却没人引用的类同样属于冗余（与令牌同一标准）
for (const c of cssClasses) if (!usedClasses.has(c)) bad.push(`定义了但未被引用的样式类 .${c}`);

/* ---------------- 5. CSS 令牌与约束 ---------------- */
const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
for (const token of new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))) {
  if (!defined.has(token)) bad.push(`使用了未定义的 CSS 变量 ${token}`);
}
for (const token of defined) {
  if (!css.includes(`var(${token}`)) bad.push(`定义了但未被引用的令牌 ${token}`);
}
for (const [, value] of css.matchAll(/border-radius:\s*([^;]+);/g)) {
  if (!['var(--radius)', '0', '0px'].includes(value.trim())) bad.push(`非直角圆角: ${value.trim()}`);
}
// 状态色只能由 [data-status] 驱动
for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  if (!/(?:^|;)\s*--status-color\s*:/.test(body)) continue;
  if (!/\[data-status="/.test(selector) && !/:not\(\[data-status\]\)/.test(selector)) {
    bad.push(`--status-color 被非 [data-status] 选择器声明: ${selector.trim()}`);
  }
}
// 动效只允许出现在提示消息区块（文件末段）
const toastAt = css.indexOf('.toasts {');
const mainAt = css.indexOf('.app-main {');
const nonToast = css.slice(0, toastAt) + css.slice(mainAt);
for (const keyword of ['transition', 'animation', '@keyframes', 'will-change']) {
  if (new RegExp(`[^-]${keyword.replace('@', '')}\\s*:`).test(nonToast) || nonToast.includes(keyword)) {
    bad.push(`提示区块之外出现动效声明 ${keyword}`);
  }
}
// CSS 里引用的本地资源必须存在（相对该 CSS 文件解析；外链与 data: 跳过）
for (const file of ['theme.css', 'base.css', 'components.css']) {
  const text = fs.readFileSync(path.join(WEB, 'css', file), 'utf8');
  for (const [, , ref] of text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    if (/^(data:|https?:|\/\/|#)/.test(ref)) continue;
    if (!fs.existsSync(path.resolve(path.join(WEB, 'css'), ref))) {
      bad.push(`${file} 引用了不存在的资源 ${ref}`);
    }
  }
}

// 布局不变量
const ruleOf = (selector) => css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
if (!/width:\s*var\(--shell-width\)/.test(ruleOf('.shell'))) bad.push('.shell 未使用 --shell-width');
if (!/flex-direction:\s*column/.test(ruleOf('.app-main'))) bad.push('.app-main 缺少 flex-direction: column（会覆盖 80% 宽度）');
for (const selector of ['.app-main', '.app-main__inner', '.sidebar', '.detail']) {
  if (!/min-height:\s*0/.test(ruleOf(selector))) bad.push(`${selector} 缺少 min-height: 0`);
}

// 侧栏空态居中不得破坏滚动：
//   .sidebar 仍是滚动容器；.tree 只负责占据剩余高度，不能自己限高或接管滚动
if (!/overflow-y:\s*auto/.test(ruleOf('.sidebar'))) bad.push('.sidebar 缺少 overflow-y: auto（长列表将无法滚动）');
const treeRule = ruleOf('.tree');
for (const prop of ['height', 'max-height', 'overflow']) {
  if (new RegExp(`(?:^|;)\\s*${prop}\\s*:`).test(treeRule)) {
    bad.push(`.tree 声明了 ${prop}，会裁剪长列表或接管滚动`);
  }
}
if (!/(?:^|;)\s*flex(?:-grow)?:\s*[^;]*\b[1-9]/.test(treeRule)) {
  bad.push('.tree 未占据侧栏剩余高度（空态将无法居中）');
}
if (!/flex:\s*none/.test(ruleOf('.sidebar__head'))) bad.push('.sidebar__head 应为 flex: none（否则会与目录树争抢高度）');

// 空态居中必须用 auto 外边距：容器高度不足时 align-items/justify-content
// 会把内容挤到滚动条够不到的一侧
const centeringRule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, , body]) => /margin:\s*auto/.test(body));
if (!centeringRule) bad.push('未找到空态的 auto 外边距居中规则');
else {
  const [, selectors] = centeringRule;
  if (!/\.empty/.test(selectors)) bad.push('auto 外边距居中未作用于 .empty');
  for (const need of ['.detail--empty', '.tree--empty']) {
    if (!selectors.includes(need)) bad.push(`空态居中规则未覆盖 ${need}`);
  }
}
// 按「逗号分隔的选择器项」精确匹配，容忍多条规则共用一处声明
const cssRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({ selectors, body }));
const ruleFor = (selector) => cssRules.find((r) => r.selectors.split(',').some((item) => item.trim() === selector));

for (const selector of ['.detail--empty', '.tree--empty']) {
  const found = ruleFor(selector);
  if (!found) {
    bad.push(`缺少 ${selector} 规则（空态无法居中）`);
    continue;
  }
  if (!/display:\s*flex/.test(found.body)) bad.push(`${selector} 未声明 display: flex`);
  if (/align-items:\s*center|justify-content:\s*center/.test(found.body)) {
    bad.push(`${selector} 用居中属性实现居中：容器高度不足时内容不可达，应改用 auto 外边距`);
  }
}

/* ---------------- 6. 模板闭环 ---------------- */
const templateIds = new Set([...html.matchAll(/<template id="([^"]+)"/g)].map((m) => m[1]));
for (const id of templateIds) if (!jsAll.includes(`'${id}'`)) bad.push(`模板 ${id} 未被 JS 使用`);
for (const id of refIds) if (id.startsWith('tpl-') && !templateIds.has(id)) bad.push(`JS 使用了不存在的模板 ${id}`);
if (/cloneTemplate\(/.test(src['render.js'] + src['detail.js'] + src['alert.js'])) {
  bad.push('渲染模块直接克隆模板，应统一走 view.js 的 fromTemplate');
}

/* ---------------- 7. 图标闭环 ---------------- */
const sprite = read('icons/sprite.svg');
const spriteIds = new Set([...sprite.matchAll(/<symbol id="([\w-]+)"/g)].map((m) => m[1]));
// 引用来源有两类：直接写死的 `sprite.svg#名称`，以及 alert.js 那样经映射表 + 模板字符串拼出的
const usedIcons = new Set([...(html + jsAll).matchAll(/sprite\.svg#([\w-]+)/g)].map((m) => m[1]));
for (const [, quoted] of jsAll.matchAll(/'([a-z][\w-]*)'/g)) {
  if (spriteIds.has(quoted)) usedIcons.add(quoted);
}
for (const name of usedIcons) {
  if (!spriteIds.has(name)) bad.push(`引用了 sprite 中不存在的图标: ${name}`);
}
// sprite 必须与生成脚本的 MANIFEST 一致：改了清单却忘记 npm run icons 会被这里拦住
const manifest = [...fs.readFileSync(path.join(ROOT, 'scripts', 'build-icons.mjs'), 'utf8').matchAll(/^\s{2}'([\w-]+)',/gm)].map(
  (m) => m[1],
);
for (const name of manifest) if (!spriteIds.has(name)) bad.push(`MANIFEST 声明了 ${name}，但 sprite 中没有（请执行 npm run icons）`);
for (const name of spriteIds) if (!manifest.includes(name)) bad.push(`sprite 中的 ${name} 不在 MANIFEST 中`);
for (const name of manifest) if (!usedIcons.has(name)) notes.push(`MANIFEST 中的 ${name} 未被页面引用`);

/* ---------------- 8. ES Module 依赖分层与导入导出闭环 ---------------- */
const LAYERS = {
  'dom.js': [],
  'theme.js': [],
  'api.js': [],
  'digest.js': [],
  'theme-init.js': [],
  'view.js': ['dom.js'],
  'render.js': ['dom.js', 'view.js'],
  'detail.js': ['dom.js', 'view.js'],
  'alert.js': ['dom.js', 'view.js'],
  // 编辑器只需要第三方源码（CodeJar），不依赖本项目其它模块
  'editor.js': ['../vendor/codejar.js'],
  // 说明渲染只需要 marked（列表与内容的取回由 app.js 用 api.js 完成）
  'intro.js': ['../vendor/marked.js'],
  'app.js': [
    'dom.js',
    'view.js',
    'render.js',
    'detail.js',
    'intro.js',
    'alert.js',
    'editor.js',
    'theme.js',
    'api.js',
    'digest.js',
  ],
};
const exportsOf = {};
const importsOf = {};
for (const [file, code] of Object.entries(src)) {
  exportsOf[file] = new Set([
    ...[...code.matchAll(/export\s+(?:async\s+)?function\s+([\w$]+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/export\s+(?:const|let|var)\s+([\w$]+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/export\s*\{([^}]+)\}/g)].flatMap((m) =>
      m[1].split(',').map((part) => part.trim().split(/\s+as\s+/).pop().trim()),
    ),
  ]);
  importsOf[file] = [...code.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/([\w.-]+)'/g)].map((m) => ({
    names: m[1].split(',').map((n) => n.trim()),
    from: m[2],
  }));
}
for (const [file, imports] of Object.entries(importsOf)) {
  for (const { names, from } of imports) {
    if (!fs.existsSync(path.join(JS_DIR, from))) {
      bad.push(`${file} 导入了不存在的模块 ${from}`);
      continue;
    }
    for (const name of names) if (!exportsOf[from].has(name)) bad.push(`${file} 从 ${from} 导入了未导出的 ${name}`);
    const allowed = LAYERS[file];
    if (allowed && !allowed.includes(from)) bad.push(`${file} 不应依赖 ${from}（违反依赖分层）`);
  }
}
// 跨目录导入：只允许引用 vendor/ 下 vendored 的第三方源码（如 CodeJar），并核对导出名
const vendorDir = path.join(WEB, 'vendor');
const vendored = new Map();
for (const file of fs.existsSync(vendorDir) ? fs.readdirSync(vendorDir).filter((f) => f.endsWith('.js')) : []) {
  const code = fs.readFileSync(path.join(vendorDir, file), 'utf8');
  vendored.set(
    `../vendor/${file}`,
    new Set([
      ...[...code.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var)\s+([\w$]+)/g)].map((m) => m[1]),
      // 压缩后的产物常用 export{a as b,...} 这种列表形式（marked 就是）：取 as 之后的导出名
      ...[...code.matchAll(/export\s*\{([^}]+)\}/g)].flatMap((m) =>
        m[1].split(',').map((part) => part.trim().split(/\s+as\s+/).pop().trim()),
      ),
    ]),
  );
}
for (const [file, code] of Object.entries(src)) {
  for (const [, names, target] of code.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\.\/[\w./-]+)'/g)) {
    const exported = vendored.get(target);
    if (!exported) {
      bad.push(`${file} 引入了 js/ 之外的模块 ${target}（只允许 vendor/ 下 vendored 的源码）`);
      continue;
    }
    for (const name of names.split(',').map((n) => n.trim())) {
      if (!exported.has(name)) bad.push(`${file} 从 ${target} 导入了未导出的 ${name}`);
    }
    if (LAYERS[file] && !LAYERS[file].includes(target)) {
      bad.push(`${file} 不应依赖 ${target}（违反依赖分层）`);
    }
  }
}

// 循环依赖
const graph = Object.fromEntries(
  Object.entries(importsOf).map(([file, imports]) => [file, imports.map((i) => i.from)]),
);
const visiting = new Set();
const visited = new Set();
const cycles = [];
const walk = (node, trail) => {
  if (visiting.has(node)) {
    cycles.push([...trail, node].join(' -> '));
    return;
  }
  if (visited.has(node)) return;
  visiting.add(node);
  for (const next of graph[node] ?? []) walk(next, [...trail, node]);
  visiting.delete(node);
  visited.add(node);
};
for (const file of Object.keys(graph)) walk(file, []);
for (const cycle of cycles) bad.push(`存在循环依赖: ${cycle}`);
// 死导出：导出但无人导入
const importedNames = new Set(Object.values(importsOf).flatMap((list) => list.flatMap((i) => i.names)));
for (const [file, names] of Object.entries(exportsOf)) {
  if (file === 'app.js') continue;
  for (const name of names) {
    if (!importedNames.has(name)) bad.push(`${file} 导出了无人引用的 ${name}`);
  }
}

/* ---------------- 9. 后端模块边界 ---------------- */
// schema.js 是纯数据模型：零项目内依赖，才能被接口层随手引用
const schemaSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'schema.js'), 'utf8');
for (const [, target] of schemaSrc.matchAll(/from\s+'([^']+)'/g)) {
  if (!target.startsWith('node:')) bad.push(`core/schema.js 引入了 ${target}（应保持零依赖的纯函数模块）`);
}
// 存储层只依赖数据模型
const storeSrc = fs.readFileSync(path.join(ROOT, 'src', 'core', 'store.js'), 'utf8');
for (const [, target] of storeSrc.matchAll(/from\s+'([^']+)'/g)) {
  if (!target.startsWith('node:') && target !== './schema.js') {
    bad.push(`core/store.js 引入了 ${target}（只应依赖 ./schema.js 与 node 内置模块）`);
  }
}
// 接口层通过 ctx.store 使用存储层：直接 import 会绕过串行写事务与内存权威
for (const file of fs.readdirSync(path.join(ROOT, 'src', 'api')).filter((f) => f.endsWith('.js'))) {
  const text = fs.readFileSync(path.join(ROOT, 'src', 'api', file), 'utf8');
  if (/from\s+'\.\.\/core\/store\.js'/.test(text)) {
    bad.push(`api/${file} 直接引入了 core/store.js，应改用 ctx.store`);
  }
}

/* ---------------- 10. 侧栏右侧竖列对齐 ---------------- */
// 头部与每个 namespace 行共用同样的右侧内边距与尺寸，徽标列、新增按钮列才会各自同列：
//   头部 padding-right  ===  .tree 的 padding-right + .node__add 的 margin-right
//   .node__head 的右内边距为 0（否则行内徽标比头部徽标多缩进一次）
//   .badge 与 .icon-btn 等高、两个 flex 容器的 gap 相同
const spaceTokens = Object.fromEntries(
  [...ruleOf(':root').matchAll(/(--space-[\w-]+):\s*(\d+)px/g)].map((m) => [m[1], Number(m[2])]),
);
const resolvePx = (raw) => {
  const value = String(raw ?? '').trim();
  const token = value.match(/^var\((--[\w-]+)\)$/);
  return token ? spaceTokens[token[1]] : Number.parseInt(value, 10);
};
/** 取简写属性的第 index 个值：CSS 简写不足 4 项时按「复制中间值」的规则补齐 */
const shorthandAt = (raw, index) => {
  const parts = String(raw ?? '').trim().split(/\s+/);
  return parts[Math.min(index, parts.length - 1)];
};
const declaration = (selector, prop) =>
  new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(ruleOf(selector))?.[1];

const headerInset = resolvePx(shorthandAt(declaration('.sidebar__head', 'padding'), 1));
const rowInset =
  resolvePx(declaration('.tree', 'padding')) + resolvePx(declaration('.node__row', 'padding-right'));
if (![headerInset, rowInset].every(Number.isFinite)) {
  bad.push('无法解析侧栏右侧内边距，竖直对齐检查失效（简写或令牌写法变了）');
} else if (headerInset !== rowInset) {
  bad.push(`侧栏右侧内边距不一致：头部 ${headerInset}px vs 行内 ${rowInset}px（徽标与新增按钮会错开）`);
}
// 留白必须挂在容器上：只读权限下写入口会被移出布局（display: none），
// 挂在按钮 margin 上的留白会一同消失，行计数就会比头部多缩进。
// 注意要扫「所有选择器里含 .node__add 的规则」，而不是恰好等于它的那条（如 .node__row:hover .node__add）。
if (
  cssRules
    .filter((rule) => /\.node__add\b/.test(rule.selectors))
    .some((rule) => /(?:^|;)\s*margin(?:-right|-inline-end)?\s*:/.test(rule.body))
) {
  bad.push('.node__add 不应声明外边距：行尾留白要挂在 .node__row 上，否则只读权限下计数列会错开');
}
const headPadRight = resolvePx(shorthandAt(declaration('.node__head', 'padding'), 1));
if (headPadRight !== 0) {
  bad.push(`.node__head 的右内边距应为 0（当前 ${headPadRight}px），否则行内徽标比头部徽标多缩进`);
}
if (
  resolvePx(declaration('.badge', 'height')) !== resolvePx(declaration('.icon-btn', 'height')) ||
  resolvePx(declaration('.badge', 'height')) !== resolvePx(declaration('.icon-btn', 'width'))
) {
  bad.push('.badge 与 .icon-btn 尺寸不一致（两列等宽时徽标列才会同列）');
}
if (declaration('.sidebar__actions', 'gap') !== declaration('.node__row', 'gap')) {
  bad.push(
    `.sidebar__actions 与 .node__row 的 gap 不一致（${declaration('.sidebar__actions', 'gap')} vs ${declaration('.node__row', 'gap')}）`,
  );
}

/* ---------------- 11. 标题单行截断 ---------------- */
// 站点标题、服务标题与说明侧栏条目都必须「单行 + 省略号 + 可收缩」：
// 少了 min-width: 0 元素不会收缩（撑破布局），缺 overflow/ellipsis 则会溢出而不是截断。
// 完整文本由 title 属性作为 tooltip 呈现（由渲染层写入，见 check-render 的断言）。
for (const [selector, label] of [
  ['.brand__title', '站点标题'],
  ['.detail__title', '服务标题'],
  ['.intro__item', '说明侧栏条目'],
]) {
  const rule = ruleFor(selector);
  if (!rule) {
    bad.push(`缺少 ${selector} 规则（长标题会撑破布局）`);
    continue;
  }
  for (const [prop, pattern] of [
    ['white-space: nowrap', /white-space:\s*nowrap/],
    ['overflow: hidden', /overflow:\s*hidden/],
    ['text-overflow: ellipsis', /text-overflow:\s*ellipsis/],
    ['min-width: 0', /min-width:\s*0/],
  ]) {
    if (!pattern.test(rule.body)) bad.push(`${label} ${selector} 缺少 ${prop}（长标题会折行或撑破布局）`);
  }
  if (/overflow-wrap|word-break/.test(rule.body)) {
    bad.push(`${label} ${selector} 声明了 overflow-wrap / word-break：应当单行截断而不是折行`);
  }
}
// 说明侧栏的条目是运行时按 /api/intro 渲染的，快照覆盖不到：
// 截断生效的前提是渲染层把完整名称写进 title，这里钉住这条写入。
if (!/button\.title\s*=\s*label/.test(src['intro.js'])) {
  bad.push('intro.js 未把完整条目名称写入 title（侧栏条目截断后无法查看全名）');
}

/* ---------------- 12. 编辑器操作区：图标按钮必须有无障碍名 ---------------- */
// 操作区里只有图标、没有可见文本：缺 title 鼠标用户悬停看不到提示，缺 aria-label 读屏用户听不到用途。
// （重置按钮的行为契约在 editor.js：load() 记下初始内容、reset() 回到它，点击即生效、不弹确认。）
const editorActions = parseDocument(html).querySelector('.editor__actions');
if (!editorActions) bad.push('index.html 缺少 .editor__actions（编辑器操作区）');
else {
  const buttons = editorActions.children.filter((child) => child.tag === 'button');
  if (buttons.length < 3) {
    bad.push(`编辑器操作区只有 ${buttons.length} 个按钮（应为 重置 / 取消 / 保存 三个）`);
  }
  for (const button of buttons) {
    const label = `#${button.getAttribute('id') ?? '(无 id)'}`;
    for (const attr of ['title', 'aria-label']) {
      if (!button.getAttribute(attr)) bad.push(`编辑器操作区的 ${label} 缺少 ${attr}`);
    }
  }
}

/* ---------------- 13. 编辑器重置：必须回到「打开弹窗时那份内容」 ---------------- */
// reset() 若改成重新生成草稿（createDraft / formatDraft）或清空，在编辑模式下会把
// 正在编辑的服务抹成骨架 —— 这是不可逆的数据损失，用一条针对性断言把它钉死。
const editorSrc = src['editor.js'];
if (!/let initial = ''/.test(editorSrc)) {
  bad.push("editor.js 未持有初始内容（reset 无从回到打开弹窗时的文本）");
}
const resetBody = /reset:\s*\(\)\s*=>\s*([^\n]*)/.exec(editorSrc)?.[1] ?? '';
if (!resetBody) bad.push('editor.js 未找到 reset 实现');
else {
  if (!/initial/.test(resetBody)) bad.push('editor.js 的 reset 没有回到 load() 记下的初始内容');
  if (/createDraft|formatDraft/.test(resetBody)) {
    bad.push('editor.js 的 reset 自行生成内容：编辑模式下会把服务抹成草稿骨架');
  }
}
if (!/load:\s*\(text\)\s*=>/.test(editorSrc)) bad.push('editor.js 未找到 load 实现（初始内容无从记录）');

/* ---------------- 14. 编辑器状态行：临时提示必须会被收回 ---------------- */
// 状态行与浮层提示不同：它常驻在弹窗里，一句「操作已完成」留在上面会让人以为弹窗卡住。
// 于是「按钮已生效」类反馈走 setTransientEditorStatus（定时收回），错误提示保持常驻。
const appSrc = src['app.js'];
// 状态行只能经 setEditorStatus 写入：它同时清掉待收回的定时器，
// 绕过它直接写状态行文本，那条旧提示就会在两秒后冒出来覆盖刚写的错误信息
const statusWrites = [...appSrc.matchAll(/dom\.editorStatus(?!\.dataset)/g)].length;
if (statusWrites !== 1) {
  bad.push(`app.js 有 ${statusWrites} 处直接写状态行（应只有 setEditorStatus 里的 1 处）`);
}
if (!/clearTimeout\(statusTimer\)/.test(appSrc)) {
  bad.push('app.js 写状态行时未清掉待收回的定时器（旧提示会覆盖新内容）');
}
if (!/statusTimer\s*=\s*setTimeout\([^;]*?setEditorStatus\(EDITOR_HINT\)/.test(appSrc)) {
  bad.push('app.js 的临时提示没有回到操作提示（EDITOR_HINT）');
}
// 重置的反馈必须是临时的，否则「已重置为初始内容」会持久留在状态行上
const resetFn = /function resetServiceEditor\(\)\s*\{([\s\S]*?)\n\}/.exec(appSrc)?.[1] ?? '';
if (!resetFn) bad.push('app.js 未找到 resetServiceEditor');
else if (!/setTransientEditorStatus\(/.test(resetFn)) {
  bad.push('resetServiceEditor 用了常驻状态行：重置提示不会自动收回');
}

/* ---------------- 15. 详情头部两个图标入口必须同尺寸 ---------------- */
// 外链入口（只剩图标）与编辑入口并排出现在详情标题右侧，尺寸不一致会一眼看出错位；
// 两者都靠 .icon-btn 基类给外观，这里只核对尺寸声明是否一致（放在同一条规则里即可）。
const entrySize = (selector) => {
  const body = ruleFor(selector)?.body ?? '';
  return ['width', 'height']
    .map((prop) => new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(body)?.[1]?.trim() ?? '未声明')
    .join(' × ');
};
const openClasses = (read('index.html').match(/class="([^"]*\bdetail__open\b[^"]*)"/)?.[1] ?? '').split(/\s+/);
if (!openClasses.includes('icon-btn')) {
  bad.push('详情外链入口未使用 .icon-btn（与编辑入口外观不一致）');
}
if (entrySize('.detail__open') !== entrySize('.detail__edit')) {
  bad.push(
    `详情头部两个图标入口尺寸不一致：外链 ${entrySize('.detail__open')} vs 编辑 ${entrySize('.detail__edit')}`,
  );
}

/* ---------------- 16. 页头半透明层：透明要看得见，文字也要读得清 ---------------- */
// 页头是 sticky 的横条（背后可能是固定底图，也可能是滚过去的卡片），于是有两条硬要求：
//   ① 模糊变体必须声明 backdrop-filter —— 少了它，滚过去的正文会与页头文字互相干扰，
//      半透明层反而比不透明更难读；
//   ② 不透明度必须真的小于 1（否则用户看到的「并没有透明」Bug 会回来），
//      同时不能太低：这里按 WCAG 公式实算「底图最暗 / 最亮」两种最坏情况下页头文字的对比度。
// 合成顺序与浏览器一致：底图象素 → 叠 --page-veil → 再叠页头自身的半透明色。
const themeTokens = (selector) => {
  const text = stripCss(read('css/theme.css'));
  const start = text.indexOf(`${selector} {`);
  const block = start < 0 ? '' : text.slice(start, text.indexOf('\n}', start));
  return Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
};
const themes = {
  light: themeTokens(':root'),
  dark: { ...themeTokens(':root'), ...themeTokens('[data-theme="dark"]') },
};
/** 解析 `hsl(H S% L% / A)` 或裸的 `H S% L%` */
const hslTriplet = (value) => {
  const m = /([\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+))?/.exec(value ?? '');
  return m ? { h: +m[1], s: +m[2], l: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
};
const hslToRgb = ({ h, s, l }) => {
  const k = (n) => (n + h / 30) % 12;
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n) => 255 * (l / 100 - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
  return [f(0), f(8), f(4)];
};
const overChannel = (fg, bg, alpha) => fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]);
const relativeLuminance = (rgb) =>
  rgb
    .map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
const contrastRatio = (a, b) => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const headerRules = cssRules.filter((rule) => rule.selectors.trim() === '.app-header');
const blurRule = headerRules.find((rule) => /backdrop-filter/.test(rule.body));
const plainRule = headerRules.find((rule) => !/backdrop-filter/.test(rule.body));
const alphaOf = (rule) => {
  const value = /background-color:\s*([^;]+)/.exec(rule?.body ?? '')?.[1]?.trim() ?? '';
  const literal = /\/\s*([\d.]+)\s*\)/.exec(value);
  if (literal) return Number(literal[1]);
  const token = /\/\s*var\((--[\w-]+)\)/.exec(value);
  return token ? Number(themes.light[token[1]] ?? themes.dark[token[1]]) : NaN;
};
if (!blurRule) {
  bad.push('.app-header 缺少 backdrop-filter 变体（半透明页头会让滚过去的正文干扰阅读）');
} else if (!/backdrop-filter:\s*blur\(/.test(blurRule.body)) {
  bad.push('.app-header 的 backdrop-filter 缺少 blur()（只透明不模糊等于没糊）');
}
if (!blurRule || !/\/\s*var\(--header-veil\)/.test(blurRule.body)) {
  bad.push('.app-header 的不透明度未引用 --header-veil（颜色值不应硬编码）');
}
if (!plainRule) bad.push('.app-header 缺少不支持 backdrop-filter 时的兜底背景色');
const headerAlpha = alphaOf(blurRule);
const fallbackAlpha = alphaOf(plainRule);
if (!(headerAlpha > 0 && headerAlpha < 1)) {
  bad.push(`.app-header 的不透明度为 ${headerAlpha}（必须介于 0 与 1 之间，"并没有透明" 的 Bug 就是这样复现的）`);
}
if (!(fallbackAlpha > headerAlpha)) {
  bad.push(`.app-header 兜底不透明度 ${fallbackAlpha} 应大于模糊变体的 ${headerAlpha}（不支持模糊时要更不透明）`);
}

// 两种主题 × 底图最暗 / 最亮：正文按 AA(4.5:1) 硬性要求；secondary 只提示不拦截 ——
// --muted-foreground 即使在不透明页头下也只有约 4.8:1（调色板本身如此），
// 而当前的 --header-veil 是刻意选的取值（50% 透明），所以这里如实报出差值 +
// 反解出「要达到门槛至少需要多大的不透明度」，把判断交回给人。
/** 反解：让某令牌在给定背影像素上达到 threshold，页头不透明度「至少」要多少
    （对比度随不透明度单调递增，所以从低往高扫、第一个达标的即为下限） */
const minAlphaFor = (tokens, pixel, colorToken, threshold) => {
  const background = hslToRgb(hslTriplet(tokens['--background']));
  const veil = hslTriplet(tokens['--page-veil']);
  const veiled = overChannel(hslToRgb(veil), pixel, veil.a);
  const target = hslToRgb(hslTriplet(tokens[colorToken]));
  for (let alpha = 0.05; alpha <= 1.0001; alpha += 0.01) {
    if (contrastRatio(overChannel(background, veiled, alpha), target) >= threshold) {
      return Math.round(alpha * 100) / 100;
    }
  }
  return null;
};
for (const [name, tokens] of Object.entries(themes)) {
  const background = hslTriplet(tokens['--background']);
  const veil = hslTriplet(tokens['--page-veil']);
  if (!background || !veil) {
    bad.push(`${name} 主题缺少 --background 或 --page-veil，无法校验页头对比度`);
    continue;
  }
  for (const [extreme, pixel] of [
    ['最暗', [0, 0, 0]],
    ['最亮', [255, 255, 255]],
  ]) {
    const surface = overChannel(hslToRgb(background), overChannel(hslToRgb(veil), pixel, veil.a), headerAlpha);
    for (const [token, threshold] of [
      ['--foreground', 4.5],
      ['--muted-foreground', 3],
    ]) {
      const ratio = contrastRatio(surface, hslToRgb(hslTriplet(tokens[token])));
      if (ratio >= threshold) continue;
      const needed = minAlphaFor(tokens, pixel, token, threshold);
      const hint = needed === null ? '即使页头完全不透明也达不到' : `--header-veil 需 ≥ ${needed.toFixed(2)}`;
      const message = `${name} 主题 + 底图${extreme} 时页头 ${token} 对比度 ${ratio.toFixed(2)}:1（门槛 ${threshold}:1，${hint}）`;
      if (token === '--foreground') bad.push(message);
      else notes.push(message);
    }
  }
}

/* ---------------- 17. 新建服务的草稿骨架：三处必须一致 ---------------- */
// 同一份骨架存在于三处，跨端无法共享模块：
//   ① 仓库数据文件 data/conf/service.schema.json（运维扩展的那份，服务启动时读入）
//   ② 服务端兜底 src/core/schema.js 的 DEFAULT_SERVICE_SCHEMA（文件缺失/损坏时顶上）
//   ③ 前端兜底 src/web/js/editor.js 的 DEFAULT_DRAFT（拿不到下发模板时顶上）
// 任何一处漂移，都会让「新建服务」的初始草稿与预期不符（字段增删顺序也参与比对）。
const { DEFAULT_SERVICE_SCHEMA } = await import(
  pathToFileURL(path.join(ROOT, 'src', 'core', 'schema.js')).href
);
const schemaFileData = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'data', 'conf', 'service.schema.json'), 'utf8'),
);
const clientKeys = [
  ...(/const DEFAULT_DRAFT = \{([\s\S]*?)\n\};/.exec(src['editor.js'])?.[1] ?? '').matchAll(/^\s{2}([\w$]+):/gm),
].map((match) => match[1]);
const serverKeys = Object.keys(DEFAULT_SERVICE_SCHEMA);
const fileKeys = Object.keys(schemaFileData);
if (!clientKeys.length) {
  bad.push('editor.js 未找到 DEFAULT_DRAFT（前端兜底骨架）');
} else if (clientKeys.join() !== serverKeys.join()) {
  bad.push(`前端兜底骨架与服务端不一致：${clientKeys.join(',')} vs ${serverKeys.join(',')}`);
}
if (fileKeys.join() !== serverKeys.join()) {
  bad.push(`data/conf/service.schema.json 的字段与服务端兜底骨架不一致：${fileKeys.join(',')} vs ${serverKeys.join(',')}`);
} else if (JSON.stringify(schemaFileData) !== JSON.stringify(DEFAULT_SERVICE_SCHEMA)) {
  bad.push('data/conf/service.schema.json 的取值与服务端兜底骨架不同（两者应完全相同）');
}

/* ---------------- 17. 说明侧栏：由 frontmatter 的三个字段控制 ---------------- */
// 侧栏的名称/顺序/显隐全部来自每个 .md 开头的 frontmatter（label / order / hidden），
// 正文不再参与。这里钉住服务端的三条关键行为：过滤 hidden、按 order 升序、
// 单篇内容剥离 frontmatter（控制字段不应混进正文发给 marked）。
const introApi = stripJs(fs.readFileSync(path.join(ROOT, 'src', 'api', 'intro.js'), 'utf8'));
if (!/function parseFrontmatter/.test(introApi) || !/function metaOf/.test(introApi)) {
  bad.push('src/api/intro.js 缺少 frontmatter 解析（侧栏无从拿到 label / order / hidden）');
}
for (const [pattern, message] of [
  [/\.filter\(\(item\) => !item\.hidden\)/, '列表未过滤 hidden 文档（hidden 应只影响侧栏显隐）'],
  [/\.sort\(\(a, b\) => a\.order - b\.order/, '列表未按 frontmatter 的 order 升序排序'],
  [/content: body\b/, '单篇接口未剥离 frontmatter（控制字段不应混进正文）'],
  [/label \|\| fallback/, '列表展示名缺 label 时应回落到文件名'],
  [/label \|\| displayName\(id\)/, '单篇展示名缺 label 时应回落到文件名'],
]) {
  if (!pattern.test(introApi)) bad.push(`src/api/intro.js：${message}`);
}
if (/titleOf/.test(introApi)) {
  bad.push('src/api/intro.js 仍引用 titleOf：侧栏名称已改由 frontmatter 的 label 提供');
}

/* ---------------- 输出 ---------------- */
console.log(`文件: ${jsFiles.join(' ')}`);
console.log(`id=${refIds.size} 模板=${templateIds.size} class=${usedClasses.size} 令牌=${defined.size} 图标=${spriteIds.size}`);
console.log(
  '模块导出: ' +
    Object.entries(exportsOf)
      .filter(([f]) => exportsOf[f].size)
      .map(([f, s]) => `${f}(${s.size})`)
      .join(' '),
);
console.log(notes.length ? `提示: ${notes.join('; ')}` : '');
console.log(bad.length ? `✘ ${bad.length} 项问题:\n - ${bad.join('\n - ')}` : '✔ 静态契约检查全部通过');
process.exit(bad.length ? 1 : 0);
