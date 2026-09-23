/**
 * 极简 DOM 垫片：供回归套件在 Node 里运行依赖 DOM 的前端模块。
 *
 * 定位：**不追求还原浏览器**，只追求「确定性」—— 同一份输入永远得到同一份序列化结果，
 * 从而让 check-render.mjs 的快照对比能够捕获真实的结构变化。
 * 只实现项目实际用到的那部分能力：
 *   createElement / createDocumentFragment / getElementById(template)
 *   classList、dataset、textContent、hidden 属性
 *   querySelector(All)：tag / #id / .class / [attr="v"] 及其后代组合
 *
 * 已知与浏览器的差异（不影响结论，因为对比双方走同一套实现）：
 *   - 不解析 HTML 实体，不保留纯空白文本节点；
 *   - 不实现事件冒泡与样式计算，addEventListener 仅记录监听器数量。
 *
 * 为什么需要它：当前环境没有任何浏览器内核，视觉验证无法自动化，
 * 于是用「结构序列化 + 逐字节比对」兜住 DOM 层面的回归，视觉部分交由人工验收。
 * 覆盖边界与恢复自动化的方式见 docs/arch.md §9.1。
 */
const VOID_TAGS = new Set(['use', 'input', 'br', 'img', 'meta', 'link', 'hr']);

class ClassList {
  constructor(node) {
    this.node = node;
  }
  add(...names) {
    for (const name of names) if (name) this.node._classes.add(name);
  }
  remove(...names) {
    for (const name of names) this.node._classes.delete(name);
  }
  contains(name) {
    return this.node._classes.has(name);
  }
  toggle(name, force) {
    const on = force === undefined ? !this.contains(name) : Boolean(force);
    if (on) this.add(name);
    else this.remove(name);
    return on;
  }
}

export class ShimNode {
  constructor(tag) {
    this.tag = tag;
    this.tagName = tag === '#fragment' ? '#fragment' : tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this._classes = new Set();
    this._dataset = {};
    this._text = '';
    this.parentNode = null;
  }

  get classList() {
    return new ClassList(this);
  }

  get className() {
    return [...this._classes].join(' ');
  }

  set className(value) {
    this._classes = new Set(
      String(value ?? '')
        .split(/\s+/)
        .filter(Boolean),
    );
  }

  get dataset() {
    return this._dataset;
  }

  get textContent() {
    return this._text;
  }

  set textContent(value) {
    this._text = value === null || value === undefined ? '' : String(value);
    this.children = [];
  }

  /* 反映型 IDL 属性：真实 DOM 里给它们赋值会同步到同名 attribute，
     垫片照做，快照才能覆盖 tooltip（title）与外链地址（href）。 */
  get title() {
    return this.getAttribute('title') ?? '';
  }

  set title(value) {
    this.setAttribute('title', value ?? '');
  }

  get href() {
    return this.getAttribute('href') ?? '';
  }

  set href(value) {
    this.setAttribute('href', value ?? '');
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  appendChild(node) {
    if (!node) return node;
    if (node.tag === '#fragment') {
      for (const child of [...node.children]) this.appendChild(child);
      node.children = [];
      return node;
    }
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  remove() {
    const parent = this.parentNode;
    if (parent) parent.children = parent.children.filter((child) => child !== this);
    this.parentNode = null;
  }

  addEventListener(type, handler) {
    if (!this._listeners) this._listeners = {};
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(handler);
  }

  listenerCount(type) {
    return this._listeners?.[type]?.length ?? 0;
  }

  cloneNode(deep) {
    const copy = new ShimNode(this.tag);
    copy._classes = new Set(this._classes);
    copy._dataset = { ...this._dataset };
    copy._text = this._text;
    copy.attributes = new Map(this.attributes);
    if (deep) for (const child of this.children) copy.appendChild(child.cloneNode(true));
    return copy;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    let scope = [this];
    let matched = [];
    for (const part of parts) {
      matched = [];
      for (const node of scope) {
        for (const candidate of descendants(node)) {
          if (matchesSimple(candidate, part)) matched.push(candidate);
        }
      }
      scope = matched;
      if (!matched.length) return [];
    }
    return matched;
  }

  /* 仅供测试断言使用 */
  toTree() {
    return {
      tag: this.tag,
      classes: [...this._classes],
      dataset: { ...this._dataset },
      attributes: Object.fromEntries([...this.attributes.entries()].sort()),
      text: this._text,
      children: this.children.map((child) => child.toTree()),
    };
  }
}

function descendants(node, out = []) {
  for (const child of node.children) {
    out.push(child);
    descendants(child, out);
  }
  return out;
}

/**
 * 支持 tag / #id / .class / [attr] / [attr="v"] 及其简单组合。
 */
function matchesSimple(node, selector) {
  const parsed = selector.match(/^([a-zA-Z0-9-]*)((?:[#.][\w-]+|\[[^\]]+\])*)$/);
  if (!parsed) throw new Error(`垫片不支持的选择器: ${selector}`);
  const [, tag, rest] = parsed;
  if (tag && node.tag.toLowerCase() !== tag.toLowerCase()) return false;

  for (const part of rest.matchAll(/[#.][\w-]+|\[[^\]]+\]/g)) {
    const chunk = part[0];
    if (chunk.startsWith('#')) {
      if (node.getAttribute('id') !== chunk.slice(1)) return false;
    } else if (chunk.startsWith('.')) {
      if (!node._classes.has(chunk.slice(1))) return false;
    } else {
      const attr = chunk.slice(1, -1).match(/^([\w-]+)(?:\s*=\s*"?([^"]*)"?)?$/);
      if (!attr) throw new Error(`垫片不支持的属性选择器: ${chunk}`);
      // data-* 在解析阶段落进了 dataset，其余落在 attributes
      const name = attr[1];
      const actual = node.attributes.has(name)
        ? node.attributes.get(name)
        : name.startsWith('data-')
          ? node._dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())]
          : undefined;
      if (attr[2] === undefined) {
        if (actual === undefined) return false;
      } else if (actual !== attr[2]) return false;
    }
  }
  return true;
}

/** 解析整份 HTML（用于按选择器核对页面结构） */
export function parseDocument(html) {
  return parseHTML(html);
}

function escapeText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function kebab(name) {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** 稳定序列化：类名按插入顺序、data-* 与其它属性按名称排序 */
export function serialize(node) {
  if (!node) return '';
  if (node.tag === '#fragment') return node.children.map((child) => serialize(child)).join('');

  const attrs = [];
  if (node._classes.size) attrs.push(`class="${[...node._classes].join(' ')}"`);
  for (const key of Object.keys(node._dataset).sort()) attrs.push(`data-${kebab(key)}="${node._dataset[key]}"`);
  for (const key of [...node.attributes.keys()].sort()) attrs.push(`${key}="${node.attributes.get(key)}"`);

  const head = `<${node.tag}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`;
  const inner = node._text ? escapeText(node._text) : '';
  return `${head}${inner}${node.children.map((child) => serialize(child)).join('')}</${node.tag}>`;
}

/** 解析极少量的模板 HTML（仅用于把 index.html 的 <template> 变成本垫片的节点树） */
export function parseHTML(html) {
  const root = new ShimNode('#fragment');
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^\s=>"']+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g;

  let match;
  while ((match = token.exec(html))) {
    const [raw, closeTag, openTag, rawAttrs, selfClose, text] = match;
    if (raw.startsWith('<!--')) continue;

    if (closeTag) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    if (openTag) {
      const el = new ShimNode(openTag);
      for (const attr of rawAttrs.matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
        const name = attr[1];
        const value = attr[2] ?? attr[3] ?? attr[4] ?? '';
        if (name === '/') continue;
        // class / data-* 需要落到垫片对应的结构上，否则类选择器与 dataset 读不到
        if (name === 'class') el.className = value;
        else if (name.startsWith('data-')) {
          const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          el.dataset[key] = value;
        } else el.setAttribute(name, value);
      }
      stack[stack.length - 1].appendChild(el);
      if (!selfClose && !VOID_TAGS.has(openTag.toLowerCase())) stack.push(el);
      continue;
    }

    if (text && text.trim()) stack[stack.length - 1]._text += text;
  }

  return root;
}

/**
 * @param {string} html index.html 内容
 * @param {string[]} elementIds 需要提前注册的空元素（如 toasts / tree / detail）
 */
export function createDocument(html, elementIds = []) {
  const templates = new Map();
  for (const match of html.matchAll(/<template id="([^"]+)">([\s\S]*?)<\/template>/g)) {
    templates.set(match[1], { content: parseHTML(match[2]) });
  }

  const elements = new Map();
  for (const id of elementIds) {
    const el = new ShimNode('div');
    el.setAttribute('id', id);
    elements.set(id, el);
  }

  const document = {
    createElement: (tag) => new ShimNode(tag),
    createDocumentFragment: () => new ShimNode('#fragment'),
    getElementById: (id) => templates.get(id) ?? elements.get(id) ?? null,
    querySelector: (selector) => null,
    querySelectorAll: () => [],
    _elements: elements,
    _templates: templates,
  };

  return document;
}
