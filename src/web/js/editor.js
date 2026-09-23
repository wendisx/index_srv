/**
 * 服务 JSON 编辑器：CodeJar（vendored，见 vendor/codejar.js）+ 自带的最小 JSON 高亮 + 草稿校验。
 *
 * 职责边界：
 * - 本模块只管「文本 ↔ 对象」的转换与校验，以及把 CodeJar 挂到宿主节点上；
 * - 弹窗开合、保存请求与页面刷新由 app.js 负责（本模块不碰网络，也不持有全局状态）。
 */
import { CodeJar } from '../vendor/codejar.js';

/** 最小 JSON 词法：字符串（区分是否为键）/ 字面量 / 数字 / 标点 */
const JSON_TOKEN = /("(?:\\.|[^"\\])*")(?:\s*(:))?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],])/g;

/**
 * 按词法把编辑器内容重绘为「纯文本 + 高亮 span」。
 *
 * 刻意用 DOM 节点重新拼装，而不是 innerHTML —— 项目约定所有文本一律走 textContent。
 * 目标只是让结构看得清，不做完备的词法分析：非法内容由 validateDraft 拦下。
 * 只供 CodeJar 回调使用，故不对外导出。
 */
function highlightJson(editor) {
  const source = editor.textContent ?? '';
  const fragment = document.createDocumentFragment();
  let cursor = 0;

  const push = (text, kind) => {
    if (!text) return;
    if (!kind) {
      fragment.appendChild(document.createTextNode(text));
      return;
    }
    const span = document.createElement('span');
    // 逐分支写字面类名（而不是拼模板串）：静态检查据此核对「类名有定义也有使用」
    if (kind === 'key') span.className = 'json-key';
    else if (kind === 'string') span.className = 'json-string';
    else if (kind === 'number') span.className = 'json-number';
    else if (kind === 'literal') span.className = 'json-literal';
    else span.className = 'json-punct';
    span.textContent = text;
    fragment.appendChild(span);
  };

  for (const match of source.matchAll(JSON_TOKEN)) {
    push(source.slice(cursor, match.index));
    const [, quoted, colon, literal, num, punct] = match;
    if (quoted) push(match[0], colon ? 'key' : 'string');
    else if (literal) push(literal, 'literal');
    else if (num) push(num, 'number');
    else push(punct, 'punct');
    cursor = match.index + match[0].length;
  }
  push(source.slice(cursor));

  editor.textContent = '';
  editor.appendChild(fragment);
}

/** 服务草稿的初始文本：按字段的既有顺序 pretty print（末尾留一个换行） */
export function formatDraft(site) {
  return `${JSON.stringify(site, null, 2)}\n`;
}

/**
 * 客户端兜底的草稿骨架。
 *
 * 正常情况下用的是**服务端下发的模板**（`GET /api/nav` 的 `serviceSchema`，
 * 来自 `data/conf/service.schema.json`，运维可在那里加字段）；本常量只在拿不到
 * 模板时顶上。跨端无法共享模块，所以它与服务端 schema.js 的 DEFAULT_SERVICE_SCHEMA、
 * 以及仓库里的 data/conf/service.schema.json 必须字面一致 —— check-static 有漂移断言。
 */
const DEFAULT_DRAFT = {
  name: '',
  url: '',
  description: '',
  icon: '',
  tags: [],
  status: 'running',
  attributes: {},
  order: 0,
  enabled: true,
};

/**
 * 新建服务的初始草稿 = 模板字段逐个占位 + 归属命名空间。
 *
 * `namespaceId` 是**上下文**而不是模板内容：模板里即使写了它，也一律以
 * 「点开的那个命名空间」为准（服务端在规范化模板时也会剔除它）。
 *
 * @param {string} namespaceId 点开的命名空间
 * @param {object} [template] 服务端下发的模板，缺省用内置兜底
 */
export function createDraft(namespaceId, template = DEFAULT_DRAFT) {
  const fields = { ...template };
  delete fields.namespaceId;
  return { namespaceId, ...fields };
}

const HTTP_URL = /^https?:\/\/\S+$/i;

/**
 * 校验编辑器内容。固有字段（name / url，以及新建时的 namespaceId）必须齐备，
 * 其余顶层字段怎么填都行 —— 服务端会原样写进数据文件。
 *
 * @param {string} text 编辑器原文
 * @param {object} [options]
 * @param {string} [options.id]              编辑模式：期望的 id（id 是主键，不可改动）
 * @param {boolean} [options.requireNamespace] 新建模式：必须写明归属命名空间
 * @returns {{ok: true, value: object} | {ok: false, message: string}}
 */
export function validateDraft(text, { id, requireNamespace = false } = {}) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `JSON 解析失败：${error.message}` };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: '顶层必须是一个 JSON 对象' };
  }
  if (id && value.id !== id) {
    return { ok: false, message: `id 是主键，不可修改（应为 ${id}）` };
  }
  if (requireNamespace && (typeof value.namespaceId !== 'string' || !value.namespaceId.trim())) {
    return { ok: false, message: 'namespaceId 必填：需要所属命名空间的 id' };
  }
  if (typeof value.name !== 'string' || !value.name.trim()) {
    return { ok: false, message: 'name 必填：需要非空字符串' };
  }
  if (value.name.length > 64) {
    return { ok: false, message: `name 最多 64 个字符（当前 ${value.name.length}）` };
  }
  if (typeof value.url !== 'string' || !HTTP_URL.test(value.url.trim())) {
    return { ok: false, message: 'url 必填：需要 http:// 或 https:// 开头的地址' };
  }
  return { ok: true, value };
}

/**
 * 把 CodeJar 挂到宿主节点上（宿主需为 contenteditable 元素）。
 * 实例只创建一次，弹窗反复开关时复用。
 *
 * 实例自己记着「初始内容」：`load()` 载入并记下它，`reset()` 回到它。
 * 这样「重置 = 回到打开弹窗时的内容」由模块保证，调用方没有写错的机会，
 * 也不必在 app.js 里另存一份副本。
 *
 * @param {HTMLElement} host
 * @returns {{load(text: string): void, reset(): void, getValue(): string}}
 */
export function createJsonEditor(host) {
  const jar = CodeJar(host, highlightJson, {
    // 与数据文件的 2 空格缩进保持一致；其余选项沿用 CodeJar 默认值
    tab: '  ',
    spellcheck: false,
  });

  /** 打开弹窗时载入的内容：重置按钮回到它（不写盘、也不跳过保存前的校验） */
  let initial = '';

  return {
    // 载入与重置都不触发 onUpdate：它们不是「用户在编辑」，别当成一次内容变更
    load: (text) => {
      initial = text;
      jar.updateCode(text, false);
    },
    reset: () => jar.updateCode(initial, false),
    getValue: () => jar.toString(),
  };
}
