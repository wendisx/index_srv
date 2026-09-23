/**
 * 视图基元：被多个渲染模块共用的结构构件。
 *
 * 分层定位：
 * - `dom.js`    —— 最底层的 DOM 工具，不认识任何业务概念；
 * - `view.js`   —— 本模块，在 dom 之上提供「模板 → 节点」「空态」「状态文案」等通用构件；
 * - `render.js` / `detail.js` —— 具体某块界面的组装，各自只负责自己的输出。
 *
 * 收录标准：**被两个及以上渲染模块复用**的构件才放这里，避免退化成杂物间。
 */
import { cloneTemplate, setText } from './dom.js';

/** 服务状态文案登记表（新增状态时在此补一行，配色令牌见 css/theme.css 的 --status-*） */
const STATUS_LABELS = {
  running: '运行中',
  stopped: '已停止',
  coming: '即将上线',
  developing: '开发中',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status ?? '未知';
}

/**
 * 克隆 `<template>` 并给出查询作用域。
 *
 * @param {string} id              模板 id（见 index.html 的 tpl-*）
 * @param {string} [rootSelector]  根节点选择器；模板为多根结构时不传，此时以 fragment 自身作为作用域
 * @returns {{ fragment: DocumentFragment, root: Element|DocumentFragment }}
 *          `fragment` 用于挂载，`root` 用于作用域内查询
 */
export function fromTemplate(id, rootSelector) {
  const fragment = cloneTemplate(id);
  const root = rootSelector ? fragment.querySelector(rootSelector) : fragment;
  if (!root) throw new Error(`模板 ${id} 中找不到 ${rootSelector}`);
  return { fragment, root };
}

/** 空态（tpl-empty）：主标题 + 提示语 */
export function createEmpty(title, hint) {
  const { fragment, root } = fromTemplate('tpl-empty', '.empty');
  setText(root.querySelector('.empty__title'), title);
  setText(root.querySelector('.empty__hint'), hint);
  return fragment;
}
