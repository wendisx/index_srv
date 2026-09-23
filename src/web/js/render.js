/**
 * 渲染层：把 /api/nav 的数据渲染为左侧目录树（namespace → service）。
 * 全部通过 <template> 克隆生成节点，仅使用 textContent 填充。
 */
import { $, setText, setTitle, toggleHidden } from './dom.js';
import { createEmpty, fromTemplate, statusLabel } from './view.js';

/** 归属缺失服务的兜底分组 id：它不是真实命名空间，因此不提供新增入口 */
const ORPHAN_ID = '__orphans__';

/** 属性值摊平为可搜索文本：容器用紧凑 JSON，与服务端 matchesQuery 的取法保持一致 */
const searchableValue = (value) =>
  value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);

function siteHaystack(site) {
  return [
    site.name,
    site.description,
    site.url,
    site.status,
    ...site.tags,
    ...Object.keys(site.attributes ?? {}),
    ...Object.values(site.attributes ?? {}).map(searchableValue),
  ]
    .join(' ')
    .toLowerCase();
}

function createService(site, selectedId) {
  const { fragment, root } = fromTemplate('tpl-service', '.svc');
  const button = $('.svc__btn', root);

  // data-status 驱动 .svc__btn 左侧状态色条
  root.dataset.siteId = site.id;
  root.dataset.status = site.status;
  if (site.id === selectedId) root.classList.add('svc--active');

  setText($('.svc__name', root), site.name);
  // 名称过长时由 CSS 截断，tooltip 展示全名；状态通过 aria-label 补充读屏信息
  setTitle(button, site.name);
  button.setAttribute('aria-label', `${site.name}（${statusLabel(site.status)}）`);

  return fragment;
}

/** 组装目录条目：每个 namespace 一项，另将归属缺失的服务兜底为「未分组」 */
function buildEntries({ namespaces, sites, query }) {
  const entries = namespaces.map((namespace) => {
    const inNamespace = sites.filter((site) => site.namespaceId === namespace.id);
    const namespaceHit =
      query.length > 0 && `${namespace.name} ${namespace.description ?? ''}`.toLowerCase().includes(query);
    return {
      id: namespace.id,
      name: namespace.name,
      description: namespace.description,
      items: namespaceHit
        ? inNamespace
        : inNamespace.filter((site) => !query || siteHaystack(site).includes(query)),
    };
  });

  const known = new Set(namespaces.map((namespace) => namespace.id));
  const orphans = sites.filter((site) => !known.has(site.namespaceId));
  if (orphans.length > 0) {
    entries.push({
      id: ORPHAN_ID,
      name: '未分组',
      description: '所属命名空间不存在',
      items: query ? orphans.filter((site) => siteHaystack(site).includes(query)) : orphans,
    });
  }

  return entries;
}

/**
 * @param {object} options
 * @param {boolean} [options.canEdit] 是否具备写权限（super）：决定是否出新增入口
 * @returns {number} 可见服务数（供页头的目录计数展示）
 */
export function renderTree({ container, nav, keyword = '', collapsed, selectedId, canEdit = false }) {
  const namespaces = nav?.namespaces ?? [];
  const sites = nav?.sites ?? [];
  const query = keyword.trim().toLowerCase();

  container.textContent = '';
  const output = document.createDocumentFragment();

  let visibleServices = 0;

  for (const entry of buildEntries({ namespaces, sites, query })) {
    // 空命名空间只有 super 需要看到（要往里添加服务），只读视图保持整洁；
    // 搜索时一律只显示有命中的
    if (entry.items.length === 0 && (query.length > 0 || !canEdit)) continue;

    const { fragment, root } = fromTemplate('tpl-namespace', '.node');
    const head = $('.node__head', root);

    // 搜索时强制展开，便于直接看到命中项
    const isCollapsed = query.length === 0 && collapsed.has(entry.id);
    root.classList.toggle('node--collapsed', isCollapsed);
    head.setAttribute('aria-expanded', String(!isCollapsed));
    head.dataset.namespaceId = entry.id;

    setText($('.node__name', root), entry.name);
    setText($('.node__count', root), String(entry.items.length));
    setTitle(head, entry.description ? `${entry.name} — ${entry.description}` : entry.name);

    // 新增服务入口：仅 super 可见；兜底分组不是真实命名空间，永远不出入口
    const addButton = $('.node__add', root);
    const canAdd = canEdit && entry.id !== ORPHAN_ID;
    toggleHidden(addButton, !canAdd);
    if (canAdd) addButton.setAttribute('aria-label', `在「${entry.name}」下添加服务`);

    const list = $('.node__list', root);
    for (const site of entry.items) list.appendChild(createService(site, selectedId));

    output.appendChild(fragment);
    visibleServices += entry.items.length;
  }

  // 空态时给容器加标记：由 CSS 让整块在侧栏剩余空间内居中
  container.classList.toggle('tree--empty', visibleServices === 0);

  if (visibleServices === 0) {
    output.appendChild(
      createEmpty(
        query ? 'No matching service' : 'No services',
        query
          ? `Nothing matches “${keyword.trim()}”`
          : 'Add services in data/section/service.json or via /api/sites',
      ),
    );
  }

  container.appendChild(output);
  return visibleServices;
}
