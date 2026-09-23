/**
 * DOM 小工具：查询、模板克隆、文本填充。
 * 约定：所有文本一律通过 textContent 写入，不使用 innerHTML，避免 XSS。
 */

export const $ = (selector, scope = document) => scope.querySelector(selector);

/** 克隆 <template id="..."> 的内容节点 */
export function cloneTemplate(id) {
  const template = document.getElementById(id);
  if (!template) throw new Error(`模板 ${id} 不存在`);
  return template.content.cloneNode(true);
}

export function setText(node, value) {
  if (node) node.textContent = value ?? '';
}

/**
 * 切换元素的 hidden 显示状态。
 *
 * 注意：这里必须操作 DOM 属性，不能写 node.hidden = false。
 * `hidden` 是 HTMLElement 的 IDL 属性，SVGElement（如 <svg id="theme-icon-*">）并没有实现它，
 * 对 <svg> 赋值 .hidden 只会挂一个普通 JS 属性，真正的 hidden 属性不会被移除，
 * 于是 [hidden] { display: none } 会一直生效，图标永远不显示。
 * 统一使用 setAttribute / removeAttribute 即可同时兼容 HTML 与 SVG 元素。
 */
export function toggleHidden(node, hidden) {
  if (!node) return;
  if (hidden) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
}

/** 与 toggleHidden 配对：读取显隐状态（同样基于属性，HTML 与 SVG 通用） */
export function isHidden(node) {
  return Boolean(node?.hasAttribute('hidden'));
}

export function setTitle(node, value) {
  if (node) node.title = value ?? '';
}

/**
 * 同一段文字同时写入 tooltip（title）与无障碍名（aria-label）。
 * 用于「只有图标、没有可见文本」的入口；若两者文案需要不同（例如服务项要在
 * 无障碍名里补上状态），仍分别写入 —— 见 render.js 的 createService。
 */
export function setLabel(node, text) {
  if (!node) return;
  setTitle(node, text);
  node.setAttribute('aria-label', text);
}

/** 简易防抖（用于搜索输入；不涉及视觉动效） */
export function debounce(fn, wait = 120) {
  let timer = null;
  return function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
}

export function isInteractiveTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable;
}
