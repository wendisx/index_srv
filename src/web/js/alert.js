/**
 * 提示消息（alert）：右上角滑入、自动滑回消失，同一时刻只保留一条。
 *
 * 约定：
 * - 结构化展示：icon + topic + content
 * - 边框色调标识类型：info 蓝 / success 绿 / warning 黄 / error 红（复用 --status-* 令牌）
 * - 若立刻来了第二条消息，前一条会被立即顶掉（不排队、不做退场动画）
 * - 支持点击消息任意位置手动关闭（带退场动画，并停止自动关闭的计时）
 */
import { $, setText, toggleHidden } from './dom.js';
import { fromTemplate } from './view.js';

const TYPE_ICONS = {
  info: 'info',
  success: 'circle-check',
  warning: 'triangle-alert',
  error: 'circle-alert',
};

/** 各类型的自动消失时长（毫秒） */
const TYPE_DURATION = {
  info: 4000,
  success: 4000,
  warning: 5000,
  error: 6000,
};

/** 与 CSS 中 .toast--leaving 的动画时长保持一致 */
const EXIT_MS = 160;

let current = null;
let timer = null;

function clear({ animate = false } = {}) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!current) return;

  const node = current;
  current = null;

  if (animate) {
    node.classList.add('toast--leaving');
    setTimeout(() => node.remove(), EXIT_MS);
    return;
  }

  // 被新消息顶掉：立即移除
  node.remove();
}

/**
 * @param {object} options
 * @param {'info'|'success'|'warning'|'error'} [options.type]
 * @param {string} options.topic    标题（必填，缺失时留空）
 * @param {string} [options.content] 正文
 * @param {number} [options.duration] 自定义停留时长（毫秒）
 */
export function showAlert({ type = 'info', topic = '', content = '', duration } = {}) {
  const container = document.getElementById('toasts');
  if (!container) return;

  clear();

  const resolvedType = TYPE_ICONS[type] ? type : 'info';
  const { fragment, root: toast } = fromTemplate('tpl-toast', '.toast');
  const contentNode = $('.toast__content', toast);

  toast.dataset.type = resolvedType;
  toast.setAttribute('role', resolvedType === 'error' ? 'alert' : 'status');
  $('.toast__icon use', toast).setAttribute('href', `./icons/sprite.svg#${TYPE_ICONS[resolvedType]}`);

  setText($('.toast__topic', toast), topic);
  setText(contentNode, content);
  toggleHidden(contentNode, !content);

  // 点击消息任意位置手动关闭；
  // stopPropagation 避免顺带触发外层的「点击面板外部」逻辑（收起权限表单）
  toast.title = '点击关闭';
  toast.addEventListener('click', (event) => {
    event.stopPropagation();
    if (current === toast) clear({ animate: true });
  });

  container.appendChild(fragment);
  current = toast;

  timer = setTimeout(() => clear({ animate: true }), duration ?? TYPE_DURATION[resolvedType]);
}

/** 立即收起当前提示（带退场动画） */
export function dismissAlert() {
  clear({ animate: true });
}
