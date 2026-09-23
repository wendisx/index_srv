/**
 * 纯逻辑回归：覆盖不依赖渲染的模块行为 —— 前端（dom / theme / view / api）
 * 与数据层纯函数（属性规范化，包括嵌套容错与原型污染防护）。
 *
 * 用法：node tests/check-logic.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDocument, serialize } from './dom-shim.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'src', 'web');
const html = fs.readFileSync(`${WEB}/index.html`, 'utf8');

const store = new Map();
const document = createDocument(html, ['toasts']);
globalThis.document = document;
globalThis.window = {
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
};

const dom = await import(pathToFileURL(`${WEB}/js/dom.js`).href);
const theme = await import(pathToFileURL(`${WEB}/js/theme.js`).href);
const view = await import(pathToFileURL(`${WEB}/js/view.js`).href);
const { api } = await import(pathToFileURL(`${WEB}/js/api.js`).href);

const bad = [];
const eq = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    bad.push(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
};

/* ---- dom ---- */
eq(dom.isHidden(null), false, 'isHidden(null) 安全');
const node = document.createElement('div');
dom.toggleHidden(node, true);
eq(node.hasAttribute('hidden'), true, 'toggleHidden 写入 hidden 属性');
dom.toggleHidden(node, false);
eq(node.hasAttribute('hidden'), false, 'toggleHidden 移除 hidden 属性');
dom.setText(node, null);
eq(node.textContent, '', 'setText(null) 归一为空串');
dom.setText(null, 'x');
eq(dom.setTitle(node, 'T'), undefined, 'setTitle 不抛错');
eq(node.title, 'T', 'setTitle 写入 title');

let calls = 0;
const debounced = dom.debounce(() => calls++, 20);
debounced();
debounced();
debounced();
await new Promise((r) => setTimeout(r, 70));
eq(calls, 1, 'debounce 合并连续调用');

/* ---- theme ---- */
const tm = theme.createThemeManager({ root: { dataset: {} } });
eq(Object.keys(tm.getState()).sort(), ['accent', 'mode', 'resolved'], 'getState 只暴露三个字段');
eq(tm.getState().mode, 'auto', '默认 auto');
eq(tm.getState().resolved, 'light', 'auto 解析为 light');
tm.cycleMode();
eq(tm.getState().mode, 'light', 'auto -> light');
tm.cycleMode();
eq(tm.getState().mode, 'dark', 'light -> dark');
eq(tm.getState().resolved, 'dark', 'dark 解析为 dark');
tm.cycleMode();
eq(tm.getState().mode, 'auto', 'dark -> auto');
eq(JSON.parse(store.get('index-srv:theme')).mode, 'auto', '模式已持久化');
tm.setAccent('bogus');
eq(tm.getState().accent, 'neutral', '非法 accent 回落 neutral');
tm.setAccent('blue');
eq(tm.getState().accent, 'blue', 'accent 生效');

// 模拟「浏览器从未设置过偏好」：清掉上一个实例写入的存储
store.clear();
const tm2 = theme.createThemeManager({ root: { dataset: {} } });
tm2.applyServerDefaults({ mode: 'dark', accent: 'rose' });
eq([tm2.getState().mode, tm2.getState().accent], ['dark', 'rose'], '无本地偏好时采用服务端默认值');
tm2.setMode('light');
tm2.applyServerDefaults({ mode: 'dark', accent: 'rose' });
eq([tm2.getState().mode, tm2.getState().accent], ['light', 'rose'], '有本地偏好后不再被服务端覆盖');

/* ---- view：状态文案与模板基元 ---- */
eq(view.statusLabel('running'), '运行中', 'statusLabel running');
eq(view.statusLabel('developing'), '开发中', 'statusLabel developing');
eq(view.statusLabel('unknown-state'), 'unknown-state', 'statusLabel 未知状态回显原值');
eq(view.statusLabel(undefined), '未知', 'statusLabel 缺省');
const empty = view.createEmpty('标题', '提示');
eq(serialize(empty), '<div class="empty"><p class="empty__title">标题</p><p class="empty__hint">提示</p></div>', 'createEmpty 结构');
const fromService = view.fromTemplate('tpl-service', '.svc');
eq(fromService.root.className, 'svc', 'fromTemplate 取出根节点');
eq(fromService.fragment.children.length, 1, 'fromTemplate 片段只含一个根');
const multi = view.fromTemplate('tpl-detail');
eq(multi.root === multi.fragment, true, 'fromTemplate 不传选择器时以 fragment 为作用域');
eq(multi.fragment.querySelector('.detail__title') !== null, true, '作用域可查询到子节点');
try {
  view.fromTemplate('tpl-namespace', '.no-such-node');
  bad.push('fromTemplate 遇到不存在的根选择器应当抛错');
} catch (error) {
  eq(/找不到/.test(error.message), true, 'fromTemplate 抛错信息含原因');
}

/* ---- 鉴权摘要：客户端与服务端必须算出同一个值 ---- */
const { sha256Hex, isDigestSupported } = await import(pathToFileURL(`${WEB}/js/digest.js`).href);
const { createHash } = await import('node:crypto');

eq(isDigestSupported(), true, '当前环境提供 Web Crypto');
eq((await sha256Hex('123456')).length, 64, '摘要为 64 位十六进制');
for (const input of ['', '123456', 'a', '服务密钥', 'x'.repeat(1000), '123456\n', ' 123456 ']) {
  eq(
    await sha256Hex(input),
    createHash('sha256').update(input, 'utf8').digest('hex'),
    `sha256Hex 与 node:crypto 一致（${JSON.stringify(input)}）`,
  );
}

/* ---- api：摘要存取与请求头 ---- */
eq(api.getDigest(), '', '默认无摘要');
const digestValue = 'a'.repeat(64);
api.setDigest(digestValue);
eq(api.getDigest(), digestValue, '摘要可设置');
eq(store.get('index-srv:digest'), digestValue, '摘要已持久化');

const realFetch = globalThis.fetch;
let lastRequest = null;
const setFetch = (impl) => {
  globalThis.fetch = (url, options) => {
    lastRequest = { url, options };
    return impl(url, options);
  };
};
setFetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: { hello: 1 } }) }));
eq(await api.nav(), { hello: 1 }, '成功响应解包 data');
eq(lastRequest.options.headers['x-service-digest'], digestValue, '请求自动附带 x-service-digest');

api.setDigest('');
eq(store.has('index-srv:digest'), false, '清空摘要会移除持久化');
await api.nav();
eq('x-service-digest' in lastRequest.options.headers, false, '无摘要时不附带鉴权头');

/* ---- api：写接口面（删除能力已整体移除，客户端不得再暴露） ---- */
eq(['deleteSite', 'deleteNamespace'].filter((name) => name in api), [], '不再暴露任何删除方法');
for (const name of ['createNamespace', 'updateNamespace', 'reorderNamespaces', 'createSite', 'updateSite', 'reorderSites']) {
  eq(typeof api[name], 'function', `保留写方法 ${name}`);
}

setFetch(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: { hello: 1 } }) }));
eq(await api.elevate(digestValue), { hello: 1 }, '提升接口提交摘要');
eq(JSON.parse(lastRequest.options.body), { digest: digestValue }, '提升请求体为摘要');
setFetch(async () => ({ ok: false, status: 409, text: async () => JSON.stringify({ ok: false, error: { code: 'conflict', message: '已存在' } }) }));
try {
  await api.nav();
  bad.push('失败响应应当抛错');
} catch (error) {
  eq([error.message, error.status, error.code], ['已存在', 409, 'conflict'], '失败响应抛出带 code/status 的错误');
}
setFetch(async () => ({ ok: true, status: 200, text: async () => 'not-json' }));
try {
  await api.nav();
  bad.push('非 JSON 响应应当抛错');
} catch (error) {
  eq(/响应解析失败/.test(error.message), true, '非 JSON 响应提示解析失败');
}
setFetch(async () => {
  throw new Error('boom');
});
try {
  await api.nav();
  bad.push('网络异常应当抛错');
} catch (error) {
  eq(/无法连接服务/.test(error.message), true, '网络异常提示无法连接');
}
globalThis.fetch = realFetch;

/* ---- 数据层：属性规范化与索引（数据模型是纯函数，可脱离文件系统直接测） ---- */
const schema = await import(pathToFileURL(`${ROOT}/src/core/schema.js`).href);
const { normalizeAttributes } = schema;

const attrs = normalizeAttributes({
  text: 'x',
  num: 1.5,
  bool: false,
  nil: null,
  list: ['a', 1, true, null],
  nested: { deep: { n: [1, 2] } },
  bad: Number.POSITIVE_INFINITY,
  container: { ok: 1, bad: Number.NaN },
});
eq(Object.keys(attrs), ['text', 'num', 'bool', 'nil', 'list', 'nested', 'container'], '属性键与顺序保持');
eq(attrs.nil, null, 'null 属性保留');
eq(attrs.list, ['a', 1, true, null], '数组属性原样保留');
eq(attrs.nested, { deep: { n: [1, 2] } }, '嵌套对象原样保留');
eq('bad' in attrs, false, '非有限数字被丢弃');
eq(attrs.container, { ok: 1 }, '嵌套中的非法值被丢弃但容器保留');

eq(Object.keys(normalizeAttributes(null)), [], '非对象输入回落为空对象');
eq(Object.keys(normalizeAttributes(['a'])), [], '数组输入回落为空对象');
eq(Object.keys(normalizeAttributes({ '  ': 1, '': 2, '\t': 3 })), [], '空键（含仅空白）被丢弃');

// 深度语义：值本身算第 1 层，容器最多嵌套 4 层
const deepOk = normalizeAttributes({ l1: { l2: { l3: { l4: { l5: 1 } } } } });
eq(deepOk.l1?.l2?.l3?.l4, { l5: 1 }, '恰好 4 层容器保留');
const deepTooDeep = normalizeAttributes({ l1: { l2: { l3: { l4: { l5: { l6: 1 } } } } } });
eq(deepTooDeep.l1.l2.l3.l4, {}, '第 5 层容器被丢弃');

const polluted = normalizeAttributes(JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}}'));
eq(Object.getPrototypeOf(polluted), null, '属性容器使用无原型对象');
eq({}.polluted, undefined, '未污染 Object.prototype');
eq('__proto__' in polluted, true, '__proto__ 作为普通键保留');

/* ---- 数据层：分区汇总与索引 ---- */
const combined = schema.combineSections(
  {
    settings: {},
    namespaces: [{ id: 'ns-a', order: 0 }],
    sites: [
      { id: 's-1', namespaceId: 'ns-a' },
      { id: 's-2', namespaceId: 'ns-missing' },
      { id: 's-3', namespaceId: 'ns-a' },
    ],
  },
  '2026-01-01T00:00:00.000Z',
);
eq(combined.version, 3, '汇总结果带当前结构版本');
eq(combined.updatedAt, '2026-01-01T00:00:00.000Z', '汇总时间戳由调用方指定');
eq(combined.settings.title, 'Index Services', '设置缺失字段补默认值');
eq(combined.sites.find((site) => site.id === 's-2').namespaceId, 'ns-a', '归属不存在的服务回落到第一个命名空间');

const index = schema.createIndex(combined);
eq(index.sitesById.get('s-1').id, 's-1', '索引可按 id 定位服务');
eq(index.namespacesById.get('ns-a').id, 'ns-a', '索引可按 id 定位命名空间');
eq(index.sitesByNamespace.get('ns-a').length, 3, '索引按归属分组（含回落后的服务）');
eq(schema.countInIndex(index, 'ns-a'), 3, 'countInIndex 取分组长度');
eq(schema.countInIndex(index, 'ns-none'), 0, 'countInIndex 未收录为 0');
eq(schema.countInIndex(index, 'ns-missing'), 0, '回落后的服务不再留在原归属下');

const bare = schema.createIndex(schema.combineSections({}));
eq([bare.sitesById.size, bare.namespacesById.size, schema.countInIndex(bare, 'x')], [0, 0, 0], '空数据下索引为空且计数为 0');

/* ---- 数据层：服务记录的自定义顶层字段（模型不认识的键原样保留） ---- */
const extrasSite = schema.normalizeSite({
  id: 's-x',
  namespaceId: 'ns-a',
  name: 'x',
  url: 'http://127.0.0.1:1',
  owner: 'ops',
  pinned: true,
  meta: { tier: 2 },
});
eq(Object.keys(extrasSite).slice(0, schema.SITE_FIELDS.length), schema.SITE_FIELDS, '模型字段仍按固定顺序排在前面');
eq(
  [extrasSite.owner, extrasSite.pinned, extrasSite.meta],
  ['ops', true, { tier: 2 }],
  '自定义顶层字段原样保留（含嵌套对象）',
);

const legacySite = schema.normalizeSite({ groupId: 'ns-a', name: 'x', url: 'http://x' });
eq('groupId' in legacySite, false, 'v1 遗留键不会再写回文件');
eq(legacySite.namespaceId, 'ns-a', 'v1 遗留键仍能映射到 namespaceId');
eq(schema.isSiteField('groupId'), true, 'isSiteField 覆盖 v1 遗留键');
eq([schema.isSiteField('name'), schema.isSiteField('owner')], [true, false], 'isSiteField 区分模型字段与自定义字段');

// __proto__ 作为自定义字段时也只能是普通自有属性
const dirtySite = schema.normalizeSite(
  JSON.parse('{"id":"s-y","name":"y","url":"http://x","__proto__":{"polluted":true}}'),
);
eq(Object.getPrototypeOf(dirtySite) === Object.prototype, true, '自定义字段不会改写记录原型');
eq(Object.prototype.polluted, undefined, '未污染 Object.prototype');
eq(Object.prototype.hasOwnProperty.call(dirtySite, '__proto__'), true, '__proto__ 成为普通自有属性');
eq(JSON.stringify(dirtySite).includes('"__proto__":{"polluted":true}'), true, '__proto__ 字段能原样写盘');

/* ---- 服务编辑器：草稿格式化与必填校验（与 /api/sites 的语义对齐） ---- */
const { createDraft, formatDraft, validateDraft } = await import(pathToFileURL(`${WEB}/js/editor.js`).href);

const draftSite = {
  id: 's-1',
  namespaceId: 'ns-a',
  name: 'demo',
  url: 'http://127.0.0.1:1',
  order: 0,
  enabled: true,
};
eq(formatDraft(draftSite), `${JSON.stringify(draftSite, null, 2)}\n`, 'formatDraft 与 JSON 两空格缩进一致');

const valid = validateDraft(formatDraft(draftSite), { id: 's-1' });
eq([valid.ok, valid.value?.name], [true, 'demo'], '合法草稿通过校验并回传对象');
eq(validateDraft(formatDraft(draftSite)).ok, true, '不传 id 时跳过 id 校验');

const invalidDrafts = [
  ['{ 坏 JSON', 'JSON 解析失败'],
  ['[]', '顶层必须是一个 JSON 对象'],
  ['"text"', '顶层必须是一个 JSON 对象'],
  ['null', '顶层必须是一个 JSON 对象'],
  [JSON.stringify({ ...draftSite, id: 'other' }), 'id 是主键'],
  [JSON.stringify({ ...draftSite, name: '' }), 'name 必填'],
  [JSON.stringify({ ...draftSite, name: '   ' }), 'name 必填'],
  [JSON.stringify({ ...draftSite, name: 'x'.repeat(65) }), 'name 最多 64'],
  [JSON.stringify({ ...draftSite, url: '' }), 'url 必填'],
  [JSON.stringify({ ...draftSite, url: 'ftp://127.0.0.1' }), 'url 必填'],
  [JSON.stringify({ ...draftSite, url: 123 }), 'url 必填'],
];
for (const [text, expected] of invalidDrafts) {
  const result = validateDraft(text, { id: 's-1' });
  if (result.ok) bad.push(`非法草稿未被拦下（期望「${expected}」）：${text.slice(0, 40)}`);
  else if (!result.message.includes(expected)) {
    bad.push(`校验文案不符：期望包含「${expected}」，实际「${result.message}」`);
  }
}

/* ---- 服务编辑器：新建草稿（类型零值占位）与新建模式校验 ---- */
const newDraft = createDraft('ns-a');
eq(Object.keys(newDraft), schema.SITE_FIELDS.slice(1), '新建草稿的字段顺序与模型一致（不含主键）');
eq(
  [newDraft.namespaceId, newDraft.name, newDraft.url, newDraft.description, newDraft.icon],
  ['ns-a', '', '', '', ''],
  '字符串字段以空串占位',
);
eq([newDraft.tags, newDraft.attributes], [[], {}], '容器字段以空容器占位');
eq([newDraft.order, newDraft.status, newDraft.enabled], [0, 'running', true], '数字取 0，status / enabled 取模型默认值');
eq('id' in newDraft, false, '新建草稿不含主键（由服务端生成）');

/* ---- 服务编辑器：草稿骨架可配置（服务端下发模板，运维可扩展字段） ---- */
const editTemplate = { owner: 'ops', name: '', url: '', tags: [], status: 'stopped' };
eq(
  createDraft('ns-a', editTemplate),
  { namespaceId: 'ns-a', ...editTemplate },
  '传入模板时按模板的字段与顺序生成草稿（含模板自定义字段）',
);
eq(
  Object.keys(createDraft('ns-a', { name: 'x', namespaceId: 'nope' })),
  ['namespaceId', 'name'],
  '归属命名空间固定在草稿第一位，（模板里若有同名字段也不影响顺序）',
);
eq(
  createDraft('ns-b', { name: 'x', namespaceId: 'nope' }).namespaceId,
  'ns-b',
  '模板里的 namespaceId 不参与：归属一律以点开的命名空间为准',
);
eq(createDraft('ns-a', {}), { namespaceId: 'ns-a' }, '空模板退化为只含归属');
eq(
  Object.keys(schema.DEFAULT_SERVICE_SCHEMA),
  schema.SITE_FIELDS.slice(2),
  '内置兜底骨架 = 模型字段去掉主键与归属',
);

/* ---- 数据层：草稿骨架的规范化（配置类文件的容错入口） ---- */
eq(
  schema.normalizeServiceSchema({ name: '', namespaceId: 'nope' }),
  { name: '' },
  '规范化草稿骨架时剔除 namespaceId（它属于上下文）',
);
eq(
  schema.normalizeServiceSchema({ name: '', 保留: { 任意: ['结构', 1] } }),
  { name: '', 保留: { 任意: ['结构', 1] } },
  '规范化保留模板里的任意自定义字段',
);
for (const [value, label] of [
  [[], '数组'],
  ['{}', '字符串'],
  [null, 'null'],
  [3, '数字'],
  [undefined, 'undefined'],
]) {
  eq(schema.normalizeServiceSchema(value), null, `${label}不是合法的草稿骨架（应回落内置兜底）`);
}

const filledDraft = { ...newDraft, name: 'demo', url: 'http://127.0.0.1:1' };
eq(validateDraft(formatDraft(filledDraft), { requireNamespace: true }).ok, true, '填好固有字段的新建草稿通过校验');
eq(
  validateDraft(formatDraft({ ...filledDraft, id: 's-custom' }), { requireNamespace: true }).ok,
  true,
  '新建时允许在草稿里自定 id',
);
eq(validateDraft(formatDraft(filledDraft)).ok, true, '不带选项时不做归属校验');
for (const [patch, expected] of [
  [{ name: '' }, 'name 必填'],
  [{ url: '' }, 'url 必填'],
  [{ namespaceId: '' }, 'namespaceId 必填'],
  [{ namespaceId: undefined }, 'namespaceId 必填'],
]) {
  const result = validateDraft(JSON.stringify({ ...filledDraft, ...patch }), { requireNamespace: true });
  if (result.ok) bad.push(`新建校验未拦下（期望「${expected}」）`);
  else if (!result.message.includes(expected)) {
    bad.push(`新建校验文案不符：期望包含「${expected}」，实际「${result.message}」`);
  }
}

console.log(bad.length ? `✘ ${bad.length} 项失败:\n - ${bad.join('\n - ')}` : '✔ 纯逻辑与数据层回归全部通过');
process.exit(bad.length ? 1 : 0);
