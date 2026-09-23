/**
 * 渲染快照对比：在 DOM 垫片里跑完全部渲染场景，与黄金基线逐字节比对。
 *
 * 为什么要这样测：前端没有构建产物，界面回归恰恰最容易出在「DOM 结构拼装」这一层
 * （漏挂节点、类名写错、文案错位、条件分支走反）。把渲染结果序列化成文本再比对，
 * 失败时能直接指出是哪个场景的哪一段变了。
 *
 * 用法：
 *   node tests/check-render.mjs            # 与基线比对，不一致则失败
 *   node tests/check-render.mjs --update   # 有意改变渲染结果时刷新基线（提交前请先审阅 diff）
 *
 * 场景输入取自 tests/fixtures/nav.json（GET /api/nav 的响应样本），
 * 它覆盖了目录树与详情的全部分支，包括：四种服务状态、缺省描述与标签、
 * 未分组兜底、属性为布尔/数字/null/对象、长名称、空命名空间列表、搜索各种命中方式。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDocument, serialize } from './dom-shim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'src', 'web');
const NAV_FILE = path.join(ROOT, 'tests', 'fixtures', 'nav.json');
const BASELINE_FILE = path.join(ROOT, 'tests', 'fixtures', 'render.expected.json');
const update = process.argv.includes('--update');

const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const payload = JSON.parse(fs.readFileSync(NAV_FILE, 'utf8'));
const nav = payload.data ?? payload;

const document = createDocument(html, ['toasts']);
globalThis.document = document;
globalThis.window = {
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
};

const render = await import(pathToFileURL(path.join(WEB, 'js', 'render.js')).href);
const detail = await import(pathToFileURL(path.join(WEB, 'js', 'detail.js')).href);
const alert = await import(pathToFileURL(path.join(WEB, 'js', 'alert.js')).href);

const snapshots = {};
const failures = [];
const makeContainer = () => document.createElement('div');

function record(name, run) {
  try {
    snapshots[name] = run();
  } catch (error) {
    failures.push(`${name} 抛出异常: ${error.message}`);
    snapshots[name] = { __error: `${error.name}: ${error.message}` };
  }
}

/* ---------------- 目录树：折叠 / 选中 / 搜索 ---------------- */
const namespaceIds = nav.namespaces.map((n) => n.id);
const treeCases = {
  default: {},
  collapsedOne: { collapsed: new Set([namespaceIds[0]]) },
  collapsedAll: { collapsed: new Set(namespaceIds) },
  collapsedUnknown: { collapsed: new Set(['__none__']) },
  selected: { selectedId: 's-grafana' },
  selectedMissing: { selectedId: 'no-such-site' },
  keywordService: { keyword: 'graf' },
  keywordUpperCase: { keyword: 'GRAFANA' },
  keywordSurroundingSpace: { keyword: '  graf  ' },
  keywordNamespace: { keyword: '监控' },
  keywordNamespaceDescription: { keyword: '告警' },
  keywordTag: { keyword: 'editor' },
  keywordAttributeKey: { keyword: 'retention' },
  keywordAttributeValue: { keyword: ' 9443' },
  keywordNestedObjectValue: { keyword: '5432' },
  keywordSliceItem: { keyword: 'beta' },
  keywordStatus: { keyword: 'stopped' },
  keywordUrl: { keyword: '9093' },
  keywordBooleanAttribute: { keyword: 'true' },
  keywordOrphan: { keyword: '孤儿' },
  keywordNoMatch: { keyword: 'zzz-nope' },
  keywordBlank: { keyword: '   ' },
  keywordIgnoresCollapsed: { keyword: 'a', collapsed: new Set(namespaceIds), selectedId: 's-nginx' },
};

for (const [name, options] of Object.entries(treeCases)) {
  record(`tree::${name}`, () => {
    const container = makeContainer();
    const visibleServices = render.renderTree({
      container,
      nav,
      keyword: options.keyword ?? '',
      collapsed: options.collapsed ?? new Set(),
      selectedId: options.selectedId ?? null,
    });
    return { html: serialize(container), visibleServices };
  });
}

record('tree::empty-nav', () => {
  const container = makeContainer();
  const visibleServices = render.renderTree({
    container,
    nav: { namespaces: [], sites: [] },
    keyword: '',
    collapsed: new Set(),
    selectedId: null,
  });
  return { html: serialize(container), visibleServices };
});

/* ---------------- 写权限（super）对目录树的影响 ---------------- */
const emptyNamespace = { id: 'ns-empty', name: '空命名空间', description: '新建后应立即可见', order: 9 };
const navWithEmpty = { ...nav, namespaces: [...nav.namespaces, emptyNamespace] };

record('tree::can-edit', () => {
  const container = makeContainer();
  const visibleServices = render.renderTree({
    container,
    nav,
    keyword: '',
    collapsed: new Set(),
    selectedId: null,
    canEdit: true,
  });
  return { html: serialize(container), visibleServices };
});

record('tree::empty-namespace-editable', () => {
  const container = makeContainer();
  const visibleServices = render.renderTree({
    container,
    nav: navWithEmpty,
    keyword: '',
    collapsed: new Set(),
    selectedId: null,
    canEdit: true,
  });
  return { html: serialize(container), visibleServices };
});

record('tree::empty-namespace-readonly', () => {
  const container = makeContainer();
  const visibleServices = render.renderTree({
    container,
    nav: navWithEmpty,
    keyword: '',
    collapsed: new Set(),
    selectedId: null,
    canEdit: false,
  });
  return { html: serialize(container), visibleServices };
});

record('tree::empty-namespace-searching', () => {
  const container = makeContainer();
  const visibleServices = render.renderTree({
    container,
    nav: navWithEmpty,
    keyword: 'grafana',
    collapsed: new Set(),
    selectedId: null,
    canEdit: true,
  });
  return { html: serialize(container), visibleServices };
});

// 兜底分组（服务指向不存在的命名空间）：即便可写也不提供新增入口
const navWithOrphan = {
  ...nav,
  sites: [...nav.sites, { ...nav.sites[0], id: 's-orphan', namespaceId: 'ns-missing', name: '孤儿服务' }],
};

record('tree::can-edit-orphan', () => {
  const container = makeContainer();
  const visibleServices = render.renderTree({
    container,
    nav: navWithOrphan,
    keyword: '',
    collapsed: new Set(),
    selectedId: null,
    canEdit: true,
  });
  return { html: serialize(container), visibleServices };
});

record('tree::no-sites', () => {
  const container = makeContainer();
  const visibleServices = render.renderTree({
    container,
    nav: { ...nav, sites: [] },
    keyword: '',
    collapsed: new Set(),
    selectedId: null,
  });
  return { html: serialize(container), visibleServices };
});

/* ---------------- 详情面板 ---------------- */
for (const site of nav.sites) {
  record(`detail::${site.id}`, () => {
    const container = makeContainer();
    detail.renderDetail({ container, site, nav });
    return { html: serialize(container) };
  });
}

record('detail::can-edit', () => {
  const container = makeContainer();
  detail.renderDetail({ container, site: nav.sites[0], nav, canEdit: true });
  return { html: serialize(container) };
});

record('detail::none-selected', () => {
  const container = makeContainer();
  detail.renderDetail({ container, site: null, nav });
  return { html: serialize(container) };
});

record('detail::open-in-same-tab', () => {
  const container = makeContainer();
  detail.renderDetail({
    container,
    site: nav.sites[0],
    nav: { ...nav, settings: { ...nav.settings, openInNewTab: false } },
  });
  return { html: serialize(container) };
});

record('detail::hide-description-and-tags', () => {
  const container = makeContainer();
  detail.renderDetail({
    container,
    site: nav.sites[0],
    nav: { ...nav, settings: { ...nav.settings, showDescription: false, showTags: false } },
  });
  return { html: serialize(container) };
});

record('detail::empty-settings', () => {
  const container = makeContainer();
  detail.renderDetail({ container, site: nav.sites[0], nav: { ...nav, settings: {} } });
  return { html: serialize(container) };
});

record('detail::no-namespaces', () => {
  const container = makeContainer();
  detail.renderDetail({ container, site: nav.sites[3], nav: { ...nav, namespaces: [] } });
  return { html: serialize(container) };
});

record('detail::bare-nav', () => {
  const container = makeContainer();
  detail.renderDetail({ container, site: nav.sites[0], nav: {} });
  return { html: serialize(container) };
});

/* ---------------- 提示消息 ---------------- */
const toasts = document.getElementById('toasts');
const resetToasts = () => {
  toasts.children = [];
};

for (const type of ['info', 'success', 'warning', 'error', 'unknown-type']) {
  record(`alert::${type}`, () => {
    resetToasts();
    alert.showAlert({ type, topic: `标题-${type}`, content: `正文-${type}` });
    const toast = toasts.children[0];
    return { html: serialize(toasts), clickListeners: toast?.listenerCount('click') ?? null };
  });
}

record('alert::defaults', () => {
  resetToasts();
  alert.showAlert({});
  return { html: serialize(toasts) };
});

record('alert::topic-only', () => {
  resetToasts();
  alert.showAlert({ type: 'error', topic: '只有标题' });
  return { html: serialize(toasts) };
});

record('alert::replaces-previous', () => {
  resetToasts();
  alert.showAlert({ topic: '第一条' });
  alert.showAlert({ type: 'success', topic: '第二条', content: '内容' });
  return { html: serialize(toasts), count: toasts.children.length };
});

record('alert::dismiss', () => {
  resetToasts();
  alert.showAlert({ topic: '待关闭' });
  alert.dismissAlert();
  return {
    html: serialize(toasts),
    leaving: toasts.children.map((node) => node._classes.has('toast--leaving')),
  };
});

record('alert::dismiss-without-toast', () => {
  resetToasts();
  alert.dismissAlert();
  return { html: serialize(toasts), count: toasts.children.length };
});

/* ---------------- 全值渲染覆盖自检 ---------------- */
// 演示服务 s-render-demo 的职责就是「一条服务覆盖全部展示形式」：
// 它一旦少了某种形态，说明样例退化了，覆盖出现空洞 —— 这里直接失败。
const COVERAGE = [
  ['status → 色调块', /class="badge badge--status"/],
  ['url → 可点击链接', /class="kv__link"/],
  ['空值（空描述 / 空标签 / null / 空数组）→ 灰字占位', /kv__value--muted/],
  ['object → JSON 代码块', /<pre class="kv__code">/],
  ['slice → chunk 块', /class="kv__chunks"><span class="chunk"/],
  ['基本类型 → 常规文本', /class="kv__value">普通字符串</],
  ['数字 / 布尔 → 等宽文本', /class="kv__value kv__value--mono"/],
];
const demoHtml = snapshots['detail::s-render-demo']?.html ?? '';
if (!demoHtml) failures.push('缺少演示服务场景 detail::s-render-demo');
for (const [label, pattern] of COVERAGE) {
  if (!pattern.test(demoHtml)) failures.push(`演示服务未覆盖展示形式：${label}`);
}

/* ---------------- 标题 tooltip 自检 ---------------- */
// 标题是单行截断的（见 css/components.css），完整名称只能靠 title 属性看 ——
// 详情面板里每个有服务的场景都必须带上它，否则长标题截断后无从查看。
for (const [name, snapshot] of Object.entries(snapshots)) {
  if (!name.startsWith('detail::') || name === 'detail::none-selected') continue;
  const tag = String(snapshot.html).match(/<h2[^>]*class="detail__title"[^>]*>/)?.[0] ?? '';
  if (!/(?:^|\s)title="/.test(tag)) {
    failures.push(`${name} 的详情标题缺少 title 属性（截断后无法查看全名）`);
  }
}

/* ---------------- 详情头部图标入口的无障碍名 ---------------- */
// 头部两个入口都只有图标、没有可见文本，含义只能由 title / aria-label 给出：
// 缺 title 鼠标悬停看不到说明，缺 aria-label 读屏用户只会听到「链接」。编辑入口仅 super 可见，故只校验未隐藏时。
for (const [name, snapshot] of Object.entries(snapshots)) {
  if (!name.startsWith('detail::') || name === 'detail::none-selected') continue;
  const html = String(snapshot.html);
  const open = html.match(/<a[^>]*class="detail__open[^"]*"[^>]*>/)?.[0] ?? '';
  if (!open) {
    failures.push(`${name} 缺少详情外链入口（.detail__open）`);
  } else {
    for (const attr of ['title', 'aria-label']) {
      if (!new RegExp(`\\s${attr}="`).test(open)) failures.push(`${name} 的外链入口缺少 ${attr}`);
    }
  }
  const edit = html.match(/<button[^>]*class="detail__edit[^"]*"[^>]*>/)?.[0];
  if (edit && !/\shidden=/.test(edit)) {
    for (const attr of ['title', 'aria-label']) {
      if (!new RegExp(`\\s${attr}="`).test(edit)) failures.push(`${name} 的编辑入口缺少 ${attr}`);
    }
  }
}

if (failures.length) {
  console.error(`✘ ${failures.length} 项失败:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}

/* ---------------- 对比 / 更新基线 ---------------- */
const total = Object.keys(snapshots).length;

if (update) {
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(snapshots, null, 2)}\n`);
  console.log(`已刷新基线 ${path.relative(ROOT, BASELINE_FILE)}：${total} 个场景`);
  console.log('请审阅 git diff，确认变化都是本次改动的预期结果。');
  process.exit(0);
}

if (!fs.existsSync(BASELINE_FILE)) {
  console.error(`✘ 缺少基线文件 ${path.relative(ROOT, BASELINE_FILE)}，先执行：node tests/check-render.mjs --update`);
  process.exit(1);
}

const expected = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
const expectedKeys = Object.keys(expected);
const changed = [];
for (const key of new Set([...expectedKeys, ...Object.keys(snapshots)])) {
  const before = JSON.stringify(expected[key]);
  const after = JSON.stringify(snapshots[key]);
  if (before !== after) changed.push({ key, before: before ?? '(不存在)', after: after ?? '(不存在)' });
}

/** 定位首个差异位置，给出上下文，便于肉眼判断改了什么 */
function firstDifference(before, after) {
  const limit = Math.min(before.length, after.length);
  let index = 0;
  while (index < limit && before[index] === after[index]) index += 1;
  const from = Math.max(0, index - 50);
  return {
    baseline: before.slice(from, index + 80),
    actual: after.slice(from, index + 80),
  };
}

if (changed.length) {
  console.error(`✘ 渲染结果与基线不一致：${changed.length} / ${expectedKeys.length} 个场景`);
  for (const item of changed.slice(0, 8)) {
    console.error(`\n  · ${item.key}`);
    if (item.before === '(不存在)') console.error('    （基线中没有这个场景，属于新增）');
    else if (item.after === '(不存在)') console.error('    （场景已从代码中移除，基线里仍有）');
    else {
      const diff = firstDifference(item.before, item.after);
      console.error(`    基线: …${diff.baseline}…`);
      console.error(`    实际: …${diff.actual}…`);
    }
  }
  if (changed.length > 8) console.error(`\n  …… 另有 ${changed.length - 8} 个场景未展开`);
  console.error('\n若变化符合预期，执行 npm run test:update 刷新基线。');
  process.exit(1);
}

console.log(
  `✔ 全值渲染覆盖自检通过（${COVERAGE.length} 种展示形式）+ 快照与基线一致（${total} 个场景${
    expectedKeys.length !== total ? `，基线 ${expectedKeys.length} 个` : ''
  }）`,
);
