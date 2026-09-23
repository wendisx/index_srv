/**
 * 详情面板：把选中服务的属性渲染为 key: value 列表。
 *
 * 行骨架由 `appendRow` 负责（key 纯文本 + 值插槽），**值怎么显示**交给值渲染管道
 * `renderValue`：规则表按顺序匹配，命中即交给对应的渲染函数加工。
 *
 * 展示规则（优先级自上而下）：
 *   1. key 级规则：`status` 显示为色调块、`url` 显示为可点击链接；
 *   2. 空值（`''` / `null` / `undefined` / 空数组）显示为灰字占位；
 *   3. `object` 类型显示为 JSON 代码块；
 *   4. `slice`（数组）类型显示为多个 chunk 块；
 *   5. 其余基本类型显示为常规文本（数字与布尔用等宽，避免与字符串混淆）。
 *
 * 新增一种展示形式 = 在 RENDER_RULES 里加一条规则 + 在 css 里加一个类，
 * 不需要改动 appendRow 与 renderDetail。
 */
import { $, setLabel, setText, setTitle, toggleHidden } from './dom.js';
import { createEmpty, fromTemplate, statusLabel } from './view.js';

/* ---------------- 类型判定 ---------------- */

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEmptyValue = (value) =>
  value === '' || value === null || value === undefined || (Array.isArray(value) && value.length === 0);

/* ---------------- 值渲染函数：一类数据一种固定展示 ---------------- */

/** 基本类型：常规文本；数字与布尔用等宽 */
function valueText(node, value) {
  setText(node, String(value));
  if (typeof value !== 'string') node.classList.add('kv__value--mono');
}

/** 空值：灰字占位 */
function valueMuted(node) {
  node.classList.add('kv__value--muted');
  setText(node, '—');
}

/** 色调块：配色由 data-status 写入的 --status-color 驱动 */
function valueStatus(node, status) {
  const badge = document.createElement('span');
  badge.className = 'badge badge--status';
  badge.dataset.status = status;
  badge.textContent = statusLabel(status);
  node.appendChild(badge);
}

/** 链接：是否新开标签页由服务端设置决定 */
function valueLink(node, url, context) {
  const link = document.createElement('a');
  link.className = 'kv__link';
  link.href = url;
  link.textContent = url;
  applyLinkTarget(link, context.openInNewTab);
  node.appendChild(link);
}

/** slice：总是显示为多个 chunk 块 */
function valueChunks(node, items) {
  const wrap = document.createElement('span');
  wrap.className = 'kv__chunks';
  for (const item of items) {
    const chunk = document.createElement('span');
    chunk.className = 'chunk';
    // 元素本身也可能是对象或数组，用紧凑 JSON 保证信息不丢失
    chunk.textContent = isPlainObject(item) || Array.isArray(item) ? JSON.stringify(item) : String(item);
    wrap.appendChild(chunk);
  }
  node.appendChild(wrap);
}

/** object：总是显示为代码块形式的 JSON */
function valueJson(node, value) {
  const code = document.createElement('pre');
  code.className = 'kv__code';
  code.textContent = JSON.stringify(value, null, 2);
  node.appendChild(code);
}

/**
 * 渲染规则表：自上而下匹配，第一条命中即生效（最后一条必须恒真，作为兜底）。
 * 渲染函数签名统一为 `(node, value, context)`，额外的参数会被忽略。
 */
const RENDER_RULES = [
  { name: 'status', match: ({ key }) => key === 'status', render: valueStatus },
  { name: 'url', match: ({ key }) => key === 'url', render: valueLink },
  { name: 'empty', match: ({ value }) => isEmptyValue(value), render: valueMuted },
  { name: 'object', match: ({ value }) => isPlainObject(value), render: valueJson },
  { name: 'slice', match: ({ value }) => Array.isArray(value), render: valueChunks },
  { name: 'basic', match: () => true, render: valueText },
];

/** 值渲染管道：选规则 → 交给规则里的渲染函数加工 */
function renderValue({ node, key, value, context }) {
  const rule = RENDER_RULES.find((item) => item.match({ key, value }));
  rule.render(node, value, context);
}

/** 链接跳转方式：新窗口打开时补上安全属性 */
function applyLinkTarget(link, openInNewTab) {
  link.target = openInNewTab === false ? '_self' : '_blank';
  if (link.target === '_blank') link.rel = 'noreferrer noopener';
}

/* ---------------- 行骨架 ---------------- */

/** 追加一行：key 为纯文本，值由渲染管道决定展示形式 */
function appendRow(list, key, value, context) {
  const { fragment, root } = fromTemplate('tpl-kv', '.kv__row');
  setText($('.kv__key', root), key);
  renderValue({ node: $('.kv__value', root), key, value, context });
  list.appendChild(fragment);
}

/* ---------------- 面板 ---------------- */

/**
 * @param {object} options
 * @param {boolean} [options.canEdit] 是否具备写权限（super）：决定是否出编辑入口
 */
export function renderDetail({ container, site, nav, canEdit = false }) {
  const settings = nav?.settings ?? {};
  const namespaces = nav?.namespaces ?? [];

  container.textContent = '';

  if (!site) {
    // 整块在面板内居中（样式见 components.css 的 .detail--empty）
    container.classList.add('detail--empty');
    container.appendChild(createEmpty('No service selected', 'Select a service on the left to see its attributes'));
    return;
  }
  container.classList.remove('detail--empty');

  const namespace = namespaces.find((item) => item.id === site.namespaceId);
  // tpl-detail 是多根结构（.detail__head + .kv），不传根选择器，直接以 fragment 作为作用域
  const { fragment, root } = fromTemplate('tpl-detail');
  const context = { openInNewTab: settings.openInNewTab };

  // 标题单行截断，完整名称交给 tooltip（与目录树里的名称同一套做法）
  const title = $('.detail__title', root);
  setText(title, site.name);
  setTitle(title, site.name);

  // 编辑 JSON 的入口：仅 super 可见
  const edit = $('.detail__edit', root);
  toggleHidden(edit, !canEdit);
  // 两个入口都只有图标、没有可见文本，含义交给 title / aria-label（见 dom.js 的 setLabel）
  if (canEdit) setLabel(edit, `编辑服务 ${site.name}`);

  const open = $('.detail__open', root);
  open.href = site.url;
  setLabel(open, `打开服务 ${site.name}`);
  applyLinkTarget(open, context.openInNewTab);

  const list = $('.kv', root);

  // 命中命名空间时显示其名称，否则回落为原始 id（为空时由渲染管道显示占位）
  appendRow(list, 'namespace', namespace ? namespace.name : site.namespaceId, context);

  appendRow(list, 'status', site.status, context);

  appendRow(list, 'url', site.url, context);

  if (settings.showDescription !== false) {
    appendRow(list, 'description', site.description, context);
  }

  if (settings.showTags !== false) {
    appendRow(list, 'tags', site.tags, context);
  }

  // 自定义属性：值可以是任意 JSON 类型，统一交由渲染管道按类型选择组件
  for (const [key, value] of Object.entries(site.attributes ?? {})) {
    appendRow(list, key, value, context);
  }

  appendRow(list, 'id', site.id, context);

  container.appendChild(fragment);
}
