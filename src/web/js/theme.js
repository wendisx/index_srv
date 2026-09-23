/**
 * 主题管理：mode（auto / light / dark）与 accent（强调色）。
 *
 * 实现要点：
 * - 只操作 <html> 上的 data-* 属性，具体配色完全由 css/theme.css 决定；
 * - auto 模式解析为实际的 light/dark 后再写入 data-theme，CSS 无需感知系统主题；
 * - 偏好持久化到 localStorage，并与 js/theme-init.js 共用同一键值结构。
 */

/** 偏好存储键：js/theme-init.js 中以字面量重写了一份，二者必须保持一致 */
const THEME_KEY = 'index-srv:theme';

/** 模式枚举，切换顺序即此数组顺序 */
const MODES = ['auto', 'light', 'dark'];

export const ACCENTS = ['neutral', 'slate', 'blue', 'green', 'violet', 'amber', 'rose'];

export const MODE_LABELS = {
  auto: '跟随系统',
  light: '浅色',
  dark: '深色',
};

export const ACCENT_LABELS = {
  neutral: '中性',
  slate: '石板',
  blue: '蓝色',
  green: '绿色',
  violet: '紫罗兰',
  amber: '琥珀',
  rose: '玫瑰',
};

function normalizeMode(value) {
  return MODES.includes(value) ? value : 'auto';
}

function normalizeAccent(value) {
  return ACCENTS.includes(value) ? value : 'neutral';
}

function readStored() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(THEME_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return { stored: null };
    return {
      stored: {
        mode: normalizeMode(raw.mode),
        accent: normalizeAccent(raw.accent),
      },
    };
  } catch (error) {
    return { stored: null };
  }
}

export function createThemeManager({ root = document.documentElement } = {}) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const { stored } = readStored();
  const listeners = new Set();

  // 本地无记录时，先使用服务端下发的默认值
  let mode = stored?.mode ?? 'auto';
  let accent = stored?.accent ?? 'neutral';
  let hasLocalPreference = Boolean(stored);

  const resolve = () => (mode === 'auto' ? (media.matches ? 'dark' : 'light') : mode);

  function getState() {
    return { mode, accent, resolved: resolve() };
  }

  function persist() {
    try {
      window.localStorage.setItem(THEME_KEY, JSON.stringify({ mode, accent }));
    } catch (error) {
      /* 忽略持久化失败 */
    }
  }

  function apply() {
    root.dataset.theme = resolve();
    root.dataset.accent = accent;
    const state = getState();
    listeners.forEach((listener) => listener(state));
    return state;
  }

  function commit() {
    hasLocalPreference = true;
    persist();
    return apply();
  }

  media.addEventListener('change', () => {
    if (mode === 'auto') apply();
  });

  return {
    getState,
    apply,

    setMode(next) {
      mode = normalizeMode(next);
      return commit();
    },

    setAccent(next) {
      accent = normalizeAccent(next);
      return commit();
    },

    /** 循环切换：auto -> light -> dark -> auto */
    cycleMode() {
      const index = MODES.indexOf(mode);
      mode = MODES[(index + 1) % MODES.length];
      return commit();
    },

    /** 首屏拉取服务端设置后调用；本地已有偏好时不覆盖 */
    applyServerDefaults({ mode: serverMode, accent: serverAccent } = {}) {
      if (!hasLocalPreference) {
        if (serverMode) mode = normalizeMode(serverMode);
        if (serverAccent) accent = normalizeAccent(serverAccent);
      }
      return apply();
    },

    subscribe(listener) {
      listeners.add(listener);
      listener(getState());
      return () => listeners.delete(listener);
    },
  };
}
