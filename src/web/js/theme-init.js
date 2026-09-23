/**
 * 首屏主题预设（经典脚本，置于 <head> 同步执行）。
 *
 * 目的：在浏览器首次绘制前写入 data-theme / data-accent，避免深色偏好下的白屏闪烁。
 * 与 js/theme.js 共用同一份 localStorage 结构（{ mode, accent }），仅此键值需保持一致。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'index-srv:theme';
  var MODES = ['auto', 'light', 'dark'];
  var ACCENTS = ['neutral', 'slate', 'blue', 'green', 'violet', 'amber', 'rose'];

  var mode = 'auto';
  var accent = 'neutral';

  try {
    var saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {};
    if (MODES.indexOf(saved.mode) !== -1) mode = saved.mode;
    if (ACCENTS.indexOf(saved.accent) !== -1) accent = saved.accent;
  } catch (error) {
    /* localStorage 不可用（隐私模式等）时使用默认值 */
  }

  var prefersDark =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;

  var root = document.documentElement;
  root.dataset.theme = mode === 'auto' ? (prefersDark ? 'dark' : 'light') : mode;
  root.dataset.accent = accent;
})();
