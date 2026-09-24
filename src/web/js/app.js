/**
 * 应用入口：单请求首屏 + 目录树/详情联动 + 主题、权限与提示消息。
 * 无外部依赖，浏览器原生 ES Module。
 */
import { api } from './api.js';
import { $, debounce, isHidden, isInteractiveTarget, setLabel, setText, setTitle, toggleHidden } from './dom.js';
import { isDigestSupported, sha256Hex } from './digest.js';
import { dismissAlert, showAlert } from './alert.js';
import { renderTree } from './render.js';
import { renderDetail } from './detail.js';
import { renderIntro, renderIntroNav } from './intro.js';
import { createDraft, createJsonEditor, formatDraft, validateDraft } from './editor.js';
import { ACCENTS, ACCENT_LABELS, MODE_LABELS, createThemeManager } from './theme.js';

const THEME_ICON_IDS = {
  auto: 'theme-icon-auto',
  light: 'theme-icon-light',
  dark: 'theme-icon-dark',
};

/** 加载提示的延迟（毫秒）：本地响应很快时不必闪现提示 */
const LOADING_ALERT_DELAY = 400;

const theme = createThemeManager();

const state = {
  nav: null,
  keyword: '',
  selectedId: null,
  /** 收纳所有已折叠的 namespace id */
  collapsed: new Set(),
};

/**
 * 输入弹窗的用途：
 *   secret    —— 提升权限，输入服务密钥（password，不留任何可见文字）
 *   namespace —— 新建命名空间，输入名称（text，带 placeholder）
 */
let modalMode = 'secret';
/** 打开弹窗的触发元素：关闭时把 aria-expanded 归还给它 */
let modalTrigger = null;

/** 服务编辑器实例：CodeJar 只创建一次，弹窗反复开关时复用 */
let editor = null;
/** 编辑器的用途：edit = 编辑选中服务；create = 在某个命名空间下新建 */
let editorMode = 'edit';
/** 编辑模式下对应的服务 id：保存时用它校验 id 未被改动 */
let editorSiteId = null;
/** 编辑器状态行的默认文案（校验失败时被错误信息替换） */
const EDITOR_HINT = 'Ctrl / ⌘ + Enter 保存 · Esc 取消';
/** 临时提示的停留时长（毫秒）：状态行就在眼前，不必像浮层提示那样长 */
const STATUS_REVERT_MS = 2000;
/** 临时提示的定时器：每次写状态行都会清掉它，避免旧提示稍后覆盖新内容 */
let statusTimer = null;

/** 需要缓存的固定节点：键即 dom.<key>，值为选择器，与 index.html 一一对应 */
const DOM_SELECTORS = {
  title: '[data-bind="title"]',
  search: '#search',
  accent: '#accent',
  themeButton: '#theme-btn',
  themeLabel: '#theme-label',
  refreshButton: '#refresh-btn',
  introButton: '#intro-btn',
  introModal: '#intro-modal',
  introNav: '#intro-nav',
  introContent: '#intro-content',
  introClose: '#intro-close',
  tree: '#tree',
  treeCount: '#tree-count',
  detail: '#detail',
  statNamespaces: '#stat-namespaces',
  statRunning: '#stat-running',
  statUpdated: '#stat-updated',
  permButton: '#perm-btn',
  permValue: '#perm-value',
  permRole: '#perm-role',
  permModal: '#perm-modal',
  permInput: '#perm-input',
  addNamespace: '#add-namespace',
  editorModal: '#editor-modal',
  editorId: '#editor-id',
  editorHost: '#editor-host',
  editorStatus: '#editor-status',
  editorReset: '#editor-reset',
  editorSave: '#editor-save',
  editorCancel: '#editor-cancel',
};

const dom = {};

function cacheDom() {
  for (const [key, selector] of Object.entries(DOM_SELECTORS)) dom[key] = $(selector);
}

/* ---------------- 加载提示 ---------------- */

let loadingAlertTimer = null;

function alertLoading() {
  if (loadingAlertTimer) clearTimeout(loadingAlertTimer);
  loadingAlertTimer = setTimeout(() => {
    loadingAlertTimer = null;
    showAlert({ type: 'info', topic: '正在加载', content: '正在获取面板数据…' });
  }, LOADING_ALERT_DELAY);
}

function stopLoadingAlert({ dismiss = false } = {}) {
  if (loadingAlertTimer) {
    clearTimeout(loadingAlertTimer);
    loadingAlertTimer = null;
  }
  if (dismiss) dismissAlert();
}

/* ---------------- 主题 ---------------- */

function syncThemeUi() {
  const { mode, resolved, accent } = theme.getState();

  for (const [key, id] of Object.entries(THEME_ICON_IDS)) {
    toggleHidden(document.getElementById(id), key !== mode);
  }

  if (dom.themeButton) {
    const label = `模式：${MODE_LABELS[mode]}${mode === 'auto' ? `（当前${resolved === 'dark' ? '深色' : '浅色'}）` : ''}，点击切换`;
    setLabel(dom.themeButton, label);
  }
  setText(dom.themeLabel, `模式：${MODE_LABELS[mode]}`);

  if (dom.accent && dom.accent.value !== accent) dom.accent.value = accent;
}

function buildAccentOptions() {
  if (!dom.accent) return;
  dom.accent.textContent = '';
  for (const accent of ACCENTS) {
    const option = document.createElement('option');
    option.value = accent;
    option.textContent = ACCENT_LABELS[accent] ?? accent;
    dom.accent.appendChild(option);
  }
}

/* ---------------- 权限级别 ---------------- */

/**
 * 权限标记：superUser = 已提升为 super；secretRequired = 服务端是否配置了服务密钥。
 * 允许直接传入权限对象，供已经有它的调用方复用，避免同一份状态取两遍。
 */
function permissionFlags(permission = state.nav?.permission ?? {}) {
  return {
    superUser: permission.level === 0,
    secretRequired: permission.secretRequired === true,
  };
}

function renderPermission() {
  const permission = state.nav?.permission ?? {};
  const { superUser, secretRequired } = permissionFlags(permission);
  // 可信网段免密钥：级别由来源网段决定，密钥与降级都不参与（见 docs/api.md）
  const trusted = permission.reason === 'trusted-network';

  setText(dom.permValue, permission.level === undefined ? '—' : String(permission.level));
  setText(dom.permRole, permission.role ?? 'user');
  dom.permButton.classList.toggle('perm-box--super', superUser);
  setTitle(
    dom.permButton,
    trusted
      ? '当前为 super（可写）：来源在白名单网段内，服务端免密钥放行'
      : superUser
        ? '当前为 super（可写），点击切回只读 user'
        : secretRequired
          ? '当前为 user（只读），点击输入服务密钥提升'
          : '当前为 user（只读）；服务端未配置 INDEX_SRV_SECRET，无法提升',
  );

  // 写操作入口：仅 super 可见（新建命名空间 / 添加服务 / 编辑服务）
  toggleHidden(dom.addNamespace, !superUser);

  // 失去写权限后编辑器已无意义，收起它，避免保存时才发现被拒
  if (!superUser && !isHidden(dom.editorModal)) closeServiceEditor();

  // 权限变化后密钥弹窗已无意义，收起它，避免留下一个悬空的输入框
  // （新建命名空间的弹窗与权限无关，不受这里影响）
  if (modalMode === 'secret' && !isHidden(dom.permModal) && (superUser || !secretRequired)) closeModal();
}

/**
 * 点击权限组件：super → 立即切回只读；user → 弹窗输入密钥。
 * 服务端未配置密钥时不可能提升，点击只说明原因。
 */
function onPermButtonClick() {
  const { superUser, secretRequired } = permissionFlags();

  // 可信网段免密钥：级别由网络决定，「切回只读」在这里无意义（下次请求服务端又发 0）
  if (state.nav?.permission?.reason === 'trusted-network') {
    showAlert({
      type: 'info',
      topic: '可信网段免密钥',
      content: '当前来源在白名单网段内，服务端直接下发 super；权限由网络决定，无需密钥',
    });
    return;
  }
  if (superUser) {
    dropPermission();
    return;
  }
  if (!secretRequired) {
    showAlert({
      type: 'info',
      topic: '只读',
      content: '服务端未配置服务密钥（INDEX_SRV_SECRET），无法提升权限',
    });
    return;
  }
  openModal('secret', dom.permButton);
}

/** 切回只读：清掉本地摘要即可，服务端不保存任何会话状态 */
async function dropPermission() {
  api.setDigest('');
  closeModal();
  await loadNav();
  showAlert({ type: 'info', topic: '已切回只读', content: '当前权限级别 3（user）' });
}

/** 打开输入弹窗；密钥用途先确认环境支持 SHA-256 */
function openModal(mode, trigger) {
  if (mode === 'secret' && !isDigestSupported()) {
    showAlert({
      type: 'error',
      topic: '无法提升权限',
      content: '当前环境不提供 Web Crypto，请改用 https 或 localhost 访问',
    });
    return;
  }

  modalMode = mode;
  modalTrigger = trigger ?? null;
  const isSecret = mode === 'secret';

  dom.permInput.type = isSecret ? 'password' : 'text';
  dom.permInput.setAttribute('aria-label', isSecret ? '服务密钥' : '命名空间名称');
  dom.permInput.placeholder = isSecret ? '' : 'namespace name';
  dom.permInput.value = '';

  toggleHidden(dom.permModal, false);
  modalTrigger?.setAttribute('aria-expanded', 'true');
  dom.permInput.focus();
}

function closeModal() {
  toggleHidden(dom.permModal, true);
  modalTrigger?.setAttribute('aria-expanded', 'false');
  modalTrigger = null;
  dom.permInput.value = '';
}

/** 弹窗里只有输入框：Enter 按当前用途分派 */
function submitModal() {
  return modalMode === 'secret' ? submitSecret() : submitNamespace();
}

/** 提交密钥：本地先算摘要，只把摘要发出去 */
async function submitSecret() {
  const secret = dom.permInput.value;
  if (!secret) return;

  try {
    const digest = await sha256Hex(secret);
    await api.elevate(digest);
    api.setDigest(digest);
    closeModal();
    await loadNav();
    showAlert({ type: 'success', topic: '已切换为 super', content: '当前权限级别 0，可执行写操作' });
  } catch (error) {
    showAlert({ type: 'error', topic: '提升失败', content: error.message });
    dom.permInput.select();
  }
}

/**
 * 新建命名空间：只需一个名称，id 与 order 由服务端生成。
 * 成功后重新拉取 /api/nav —— 新条目出现在列表里，页脚的 LAST MODIFY 也随落盘时间一并更新。
 */
async function submitNamespace() {
  const name = dom.permInput.value.trim();
  if (!name) return;

  try {
    const created = await api.createNamespace({ name });
    closeModal();
    // 新命名空间保持展开，便于接着往里添加服务
    state.collapsed.delete(created.id);
    await loadNav();
    showAlert({ type: 'success', topic: '已新建命名空间', content: name });
  } catch (error) {
    showAlert({ type: 'error', topic: '新建命名空间失败', content: error.message });
    dom.permInput.select();
  }
}

/* ---------------- 服务编辑（JSON） ---------------- */

/**
 * 状态行：默认显示操作提示，校验或写入失败时切换为错误样式。
 *
 * 这是状态行的**唯一**写入入口：任何一次写入都作废尚未到点的临时提示，
 * 否则那条提示会在两秒后冒出来覆盖这里刚写的错误信息。
 */
function setEditorStatus(message, tone = '') {
  clearTimeout(statusTimer);
  statusTimer = null;
  setText(dom.editorStatus, message);
  if (tone) dom.editorStatus.dataset.tone = tone;
  else delete dom.editorStatus.dataset.tone;
}

/**
 * 临时状态：先展示一段提示，一段时间后自动换回操作提示。
 *
 * 用于「按钮已生效」这类不需要用户处理的反馈 —— 一直留在状态行上会让人以为弹窗卡住；
 * 校验/写入失败刻意不走这里：它是待处理的，要留到用户动手或关窗。
 * 也不引入动效，只是定时换文本（项目约定动效只出现在提示消息区块）。
 */
function setTransientEditorStatus(message) {
  setEditorStatus(message);
  statusTimer = setTimeout(() => setEditorStatus(EDITOR_HINT), STATUS_REVERT_MS);
}

/**
 * 打开编辑器弹窗（编辑与新建共用同一套界面）：
 * 填好草稿与标题后显示，并把焦点交给编辑器。
 */
function showEditor({ mode, id = null, draft }) {
  editorMode = mode;
  editorSiteId = id;
  setText(dom.editorId, id ?? '');
  setEditorStatus(EDITOR_HINT);
  // 这份文本同时成为「初始内容」：重置按钮会回到它（见 editor.js 的 load / reset）
  editor.load(formatDraft(draft));
  toggleHidden(dom.editorModal, false);
  dom.editorHost.focus();
}

/**
 * 重置编辑区：回到打开弹窗时的内容，点击即生效 —— 刻意不做二次确认，
 * 它只改编辑区，既不写盘也不会绕过保存前的校验。
 */
function resetServiceEditor() {
  editor.reset();
  // 临时提示：两秒后自动回到操作提示，不占着状态行
  setTransientEditorStatus('已重置为初始内容');
  dom.editorHost.focus();
}

/** 当前选中的服务：未选中或已被删除时为 null（编辑入口与详情面板共用） */
const selectedSite = () =>
  state.nav?.sites.find((item) => item.id === state.selectedId) ?? null;

/**
 * 编辑选中服务：以它的完整记录作为初始草稿。
 * 其中 id 不允许改动（服务端也会忽略请求体里的 id）。
 */
function openServiceEditor() {
  const site = selectedSite();
  if (!site) return;
  showEditor({ mode: 'edit', id: site.id, draft: site });
}

/**
 * 新建服务：草稿取自服务端下发的模板（data/conf/service.schema.json，可运维扩展），
 * 归属为点开的那个命名空间。
 */
function openServiceCreator(namespaceId) {
  if (!namespaceId) return;
  showEditor({ mode: 'create', draft: createDraft(namespaceId, state.nav?.serviceSchema) });
}

function closeServiceEditor() {
  toggleHidden(dom.editorModal, true);
  editorMode = 'edit';
  editorSiteId = null;
  setEditorStatus('');
}

/**
 * 保存：先校验固有字段，再写回服务，最后重拉 /api/nav
 * （目录、详情与页脚 LAST MODIFY 随落盘时间一并刷新）。
 * 校验不过或服务端拒绝时留在弹窗里，把原因写进状态行。
 */
async function saveServiceEditor() {
  const isEdit = editorMode === 'edit';
  const draft = validateDraft(
    editor.getValue(),
    isEdit ? { id: editorSiteId } : { requireNamespace: true },
  );
  if (!draft.ok) {
    setEditorStatus(draft.message, 'error');
    return;
  }

  try {
    if (isEdit) {
      if (!editorSiteId) return;
      await api.updateSite(editorSiteId, draft.value);
      closeServiceEditor();
      await loadNav();
      showAlert({ type: 'success', topic: '已保存服务', content: draft.value.name });
      return;
    }

    const created = await api.createSite(draft.value);
    closeServiceEditor();
    // 新服务要立刻可见：展开它所属的命名空间，并直接选中它
    state.collapsed.delete(created.namespaceId);
    state.selectedId = created.id;
    await loadNav();
    showAlert({ type: 'success', topic: '已保存服务', content: created.name });
  } catch (error) {
    setEditorStatus(error.message, 'error');
  }
}

/* ---------------- 渲染 ---------------- */

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未知时间';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function renderDetailPane() {
  const site = selectedSite();
  renderDetail({
    container: dom.detail,
    site,
    nav: state.nav ?? { settings: {}, namespaces: [] },
    canEdit: permissionFlags().superUser,
  });
}

function render() {
  if (!state.nav) return;
  const { settings, stats } = state.nav;

  document.title = settings.title;
  // 站点标题单行截断，完整标题交给 tooltip
  setText(dom.title, settings.title);
  setTitle(dom.title, settings.title);

  renderPermission();

  const visibleServices = renderTree({
    container: dom.tree,
    nav: state.nav,
    keyword: state.keyword,
    collapsed: state.collapsed,
    selectedId: state.selectedId,
    canEdit: permissionFlags().superUser,
  });
  setText(dom.treeCount, String(visibleServices));

  renderDetailPane();

  setText(dom.statNamespaces, String(stats.namespaces));
  setText(dom.statRunning, `${stats.running}/${stats.services}`);
  setText(dom.statUpdated, formatTime(stats.updatedAt));
}

/* ---------------- 数据加载 ---------------- */

async function loadNav() {
  alertLoading();
  try {
    const nav = await api.nav();
    state.nav = nav;
    // 选中的服务可能已被删除或禁用，及时清理
    if (state.selectedId && !nav.sites.some((site) => site.id === state.selectedId)) {
      state.selectedId = null;
    }
    stopLoadingAlert({ dismiss: true });
    render();
  } catch (error) {
    stopLoadingAlert();
    showAlert({
      type: 'error',
      topic: '加载失败',
      content: `${error.message}，可点击右上角刷新重试`,
    });
    setText(dom.statUpdated, '加载失败');
  }
}

/* ---------------- 交互 ---------------- */

function selectSite(id) {
  state.selectedId = id;
  for (const element of dom.tree.querySelectorAll('.svc--active')) element.classList.remove('svc--active');
  const item = dom.tree.querySelector(`.svc[data-site-id="${CSS.escape(id)}"]`);
  if (item) item.classList.add('svc--active');
  renderDetailPane();
}

function onTreeClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  // 行尾的新增服务入口：在该命名空间下新建服务
  const addService = target.closest('.node__add');
  if (addService) {
    const node = addService.closest('.node');
    openServiceCreator($('.node__head', node)?.dataset.namespaceId ?? '');
    return;
  }

  const head = target.closest('.node__head');
  if (head) {
    const root = head.closest('.node');
    const collapsed = root.classList.toggle('node--collapsed');
    head.setAttribute('aria-expanded', String(!collapsed));
    const id = head.dataset.namespaceId;
    if (collapsed) state.collapsed.add(id);
    else state.collapsed.delete(id);
    return;
  }

  const item = target.closest('.svc');
  if (item) selectSite(item.dataset.siteId);
}

/** 详情面板的点击：编辑入口（按钮本身仅 super 可见） */
function onDetailClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('.detail__edit')) openServiceEditor();
}

/* ---------------- 说明弹窗 ---------------- */

/** 说明文档的形态：dir（目录，带 sidebar）/ file（单文件）/ none（不显示入口） */
let introMode = 'none';
/** 文档列表（目录形态下可能有多篇） */
let introItems = [];
/** 当前选中的文档 id */
let introId = '';

/**
 * 打开说明弹窗：先载入文档清单，再渲染第一篇。
 * 形态由服务端决定 —— 目录 → 左侧 sidebar + 右侧内容；单文件 → 只有内容。
 */
async function openIntro() {
  toggleHidden(dom.introModal, false);
  try {
    const index = await api.introIndex();
    introMode = index?.mode ?? 'none';
    introItems = index?.items ?? [];

    // 没有文档可用时收起入口：不留一个点了没反应的按钮
    if (introMode === 'none' || introItems.length === 0) {
      closeIntro();
      toggleHidden(dom.introButton, true);
      return;
    }

    // 只有目录形态才显示 sidebar（单文件形态按约定只给内容区）
    toggleHidden(dom.introNav, introMode !== 'dir');
    if (introMode === 'dir') {
      renderIntroNav(dom.introNav, introItems, introId || introItems[0].id, selectIntroDoc);
    }
    await selectIntroDoc(introId || introItems[0].id);
  } catch (error) {
    closeIntro();
    showAlert({ type: 'error', topic: '说明加载失败', content: error.message });
  }
}

/** 选中并渲染某一篇说明 */
async function selectIntroDoc(id) {
  introId = id;
  if (introMode === 'dir') renderIntroNav(dom.introNav, introItems, id, selectIntroDoc);
  try {
    const doc = await api.introDoc(id);
    renderIntro(dom.introContent, doc?.content ?? '');
  } catch (error) {
    showAlert({ type: 'error', topic: '说明加载失败', content: error.message });
  }
}

function closeIntro() {
  toggleHidden(dom.introModal, true);
}

function bindEvents() {
  dom.search.addEventListener(
    'input',
    debounce(() => {
      state.keyword = dom.search.value;
      render();
    }, 120),
  );

  document.addEventListener('keydown', (event) => {
    // Ctrl / ⌘ + Enter：保存编辑器内容（编辑器里的普通 Enter 是换行）
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !isHidden(dom.editorModal)) {
      event.preventDefault();
      saveServiceEditor();
      return;
    }

    if (event.key === 'Escape') {
      // 弹窗按「后开的先关」顺序收起：服务编辑器 → 权限输入
      if (!isHidden(dom.editorModal)) {
        closeServiceEditor();
        return;
      }
      if (!isHidden(dom.permModal)) {
        closeModal();
        return;
      }
      if (!isHidden(dom.introModal)) {
        closeIntro();
        return;
      }
      if (dom.search.value) {
        dom.search.value = '';
        state.keyword = '';
        render();
      }
      return;
    }

    // 「/」聚焦搜索框（输入状态下不劫持）
    if (event.key === '/' && !isInteractiveTarget(event.target) && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      dom.search.focus();
      dom.search.select();
    }
  });

  dom.tree.addEventListener('click', onTreeClick);
  dom.detail.addEventListener('click', onDetailClick);
  dom.themeButton.addEventListener('click', () => theme.cycleMode());
  dom.accent.addEventListener('change', () => theme.setAccent(dom.accent.value));
  dom.refreshButton.addEventListener('click', () => loadNav());

  dom.permButton.addEventListener('click', (event) => {
    event.stopPropagation();
    onPermButtonClick();
  });

  // 新建命名空间：复用同一个输入弹窗
  dom.addNamespace.addEventListener('click', () => openModal('namespace', dom.addNamespace));

  // 弹窗里只有输入框：Enter 提交，点击遮罩（输入框以外）关闭
  dom.permInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitModal();
  });
  dom.permModal.addEventListener('click', (event) => {
    if (event.target === dom.permModal) closeModal();
  });

  // 编辑器：保存 / 取消 / 点击遮罩关闭
  dom.editorSave.addEventListener('click', () => saveServiceEditor());
  dom.editorCancel.addEventListener('click', () => closeServiceEditor());
  dom.editorReset.addEventListener('click', () => resetServiceEditor());
  dom.editorModal.addEventListener('click', (event) => {
    if (event.target === dom.editorModal) closeServiceEditor();
  });

  // 说明：入口在页头，关闭方式与其它弹窗一致（关闭按钮 / 点击遮罩 / Esc）
  dom.introButton.addEventListener('click', () => openIntro());
  dom.introClose.addEventListener('click', () => closeIntro());
  dom.introModal.addEventListener('click', (event) => {
    if (event.target === dom.introModal) closeIntro();
  });
}

/* ---------------- 启动 ---------------- */

async function boot() {
  cacheDom();
  // CodeJar 只挂载一次：弹窗反复开关复用同一个实例
  editor = createJsonEditor(dom.editorHost);
  buildAccentOptions();
  theme.subscribe(syncThemeUi);
  theme.apply();
  bindEvents();

  // 首屏只请求 /api/nav（设置 / 权限 / 目录 / 服务 / 统计都在其中）
  await loadNav();
  theme.applyServerDefaults({
    mode: state.nav?.settings.theme,
    accent: state.nav?.settings.accent,
  });
}

boot();
