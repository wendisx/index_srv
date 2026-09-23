/**
 * 说明弹窗的渲染层：Markdown → DOM。
 *
 * 内容来自 `GET /api/intro/:id` 的 Markdown 原文，用 vendored 的 marked 解析。
 * 布局由调用方按 `mode` 决定：目录形态渲染左侧 sidebar，单文件形态只渲染内容 ——
 * 差别只在有没有那份列表，渲染本身与形态无关。
 *
 * 两条项目约定在这里交汇，因此实现上刻意绕了一下：
 *   1. 禁用 innerHTML（防 XSS）：marked 产出的是 HTML 字符串，先用 DOMParser
 *      变成节点、清洗之后再插入，全程不碰 innerHTML；
 *   2. CSS 用扁平 BEM、不用嵌套选择器：渲染出的元素统一打上 md-* 扁平类名，
 *      样式只针对这些类（而不是写 `.intro__content h1` 这种嵌套）。
 */
import { marked } from '../vendor/marked.js';

/** 说明文档不需要这些元素，一律丢弃 */
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base']);

/** 脚本类 URL：即便文档是自己写的也不该生效 */
const UNSAFE_URL = /^\s*(javascript|data|vbscript)\s*:/i;



/** 清洗：删掉危险元素、事件属性与脚本类 URL（其余排版元素原样保留） */
function sanitize(root) {
  for (const node of Array.from(root.querySelectorAll('*'))) {
    if (DROP_TAGS.has(node.tagName.toLowerCase())) {
      node.remove();
      continue;
    }
    for (const { name, value } of Array.from(node.attributes)) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on')) node.removeAttribute(name);
      else if ((lower === 'href' || lower === 'src') && UNSAFE_URL.test(value)) node.removeAttribute(name);
    }
  }
}

/** 渲染 Markdown 到容器（替换原有内容） */
export function renderIntro(container, markdown) {
  const doc = new DOMParser().parseFromString(marked.parse(markdown ?? ''), 'text/html');
  sanitize(doc.body);
  const nodes = Array.from(doc.body.childNodes).map((node) => document.importNode(node, true));
  container.replaceChildren(...nodes);
}

/** 渲染左侧文档列表（只有目录形态会用到） */
export function renderIntroNav(nav, items, activeId, onSelect) {
  const buttons = items.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'intro__item';
    const label = item.name ?? item.id;
    button.textContent = label;
    // 标题单行截断（见 .intro__item 的样式），完整名称交给 tooltip
    button.title = label;
    if (item.id === activeId) button.classList.add('intro__item--active');
    button.addEventListener('click', () => onSelect(item.id));
    return button;
  });
  nav.replaceChildren(...buttons);
}
