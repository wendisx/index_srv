/**
 * 数据模型：常量、归一化、索引与视图计算。
 *
 * 本模块全部是**纯函数**（不碰文件系统、不持有状态），因此接口层可以自由引用；
 * 与文件打交道的那一层在 core/store.js。
 *
 * 术语：持久化文件与界面用「服务」(service)，代码与接口沿用既有的 sites 命名，
 * 两者的对应关系集中在 core/store.js 的分区表里。
 */
import { randomUUID } from 'node:crypto';

/** 数据结构版本：v1 groups / v2 namespaces + attributes / v3 分区文件 */
export const SCHEMA_VERSION = 3;

/** 服务状态：红 stopped / 绿 running / 蓝 coming / 黄 developing */
export const SITE_STATUSES = ['running', 'stopped', 'coming', 'developing'];

/** 面板设置默认值：缺失字段的补齐来源，也是 settings 分区的初值 */
export const DEFAULT_SETTINGS = Object.freeze({
  title: 'Index Services',
  description: '个人云服务索引面板',
  theme: 'auto',
  accent: 'neutral',
  showDescription: true,
  showTags: true,
  openInNewTab: true,
});

/** 允许的主题取值：设置接口校验与设置归一化共用同一份来源 */
export const THEMES = ['auto', 'light', 'dark'];

/**
 * 新建服务的草稿骨架（兜底值）：字段逐个占位，一眼看清可以填哪些。
 *
 * 取值原则是类型零值 —— 字符串 `''`、数组 `[]`、对象 `{}`、数字 `0`；
 * `status` 与 `enabled` 例外：它们的「零值」分别是「非法枚举」与「建出来就是隐藏的」，
 * 所以取模型默认值（running / true）。
 *
 * 不含 `id`（主键由服务端生成，想指定也可以写进模板）与 `namespaceId`
 * （归属是「点开的那个命名空间」这一上下文，由客户端注入）。
 *
 * 运行时以 `data/conf/service.schema.json` 为准（运维可在此扩展新字段）；
 * 本常量只在那个文件缺失或不可用时兜底。前端 `editor.js` 另有一份等价的客户端兜底
 * —— 跨端无法共享模块，两者与仓库里的文件必须字面一致，由 check-static 断言。
 */
export const DEFAULT_SERVICE_SCHEMA = Object.freeze({
  name: '',
  url: '',
  description: '',
  icon: '',
  tags: [],
  status: 'running',
  attributes: {},
  order: 0,
  enabled: true,
});

/**
 * 规范化草稿骨架：必须是 JSON 对象，且一律剔除 `namespaceId`
 * （它属于上下文而非模板内容，客户端会按点开的命名空间注入）。
 * 返回 null 表示「不可用」，由调用方回落到 DEFAULT_SERVICE_SCHEMA。
 */
export function normalizeServiceSchema(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const schema = { ...raw };
  delete schema.namespaceId;
  return schema;
}

export function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function asBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asOrder(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function normalizeSettings(raw = {}) {
  return {
    title: asString(raw.title, DEFAULT_SETTINGS.title) || DEFAULT_SETTINGS.title,
    description: asString(raw.description, DEFAULT_SETTINGS.description),
    theme: THEMES.includes(raw.theme) ? raw.theme : DEFAULT_SETTINGS.theme,
    accent: asString(raw.accent, DEFAULT_SETTINGS.accent) || DEFAULT_SETTINGS.accent,
    showDescription: asBool(raw.showDescription, DEFAULT_SETTINGS.showDescription),
    showTags: asBool(raw.showTags, DEFAULT_SETTINGS.showTags),
    openInNewTab: asBool(raw.openInNewTab, DEFAULT_SETTINGS.openInNewTab),
  };
}

/** 自由属性允许的最大嵌套层数（值本身算第 1 层），避免面板数据被写成任意 JSON 仓库 */
const MAX_ATTRIBUTE_DEPTH = 4;

/**
 * 规范化单个属性值：支持 JSON 原语（字符串 / 数字 / 布尔 / null）以及嵌套的数组与对象。
 * 读取侧做宽松容错 —— 非法值直接丢弃（返回 undefined）而不是抛错，保证手工编辑过的
 * 数据文件仍能正常加载。
 */
function normalizeAttributeValue(value, level) {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'string' || type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : undefined;
  if (type !== 'object' || level > MAX_ATTRIBUTE_DEPTH) return undefined;

  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeAttributeValue(item, level + 1))
      .filter((item) => item !== undefined);
  }

  // 用无原型对象承载，避免 __proto__ 这类键触发原型污染
  const out = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    const name = String(key).trim();
    if (!name) continue;
    const normalized = normalizeAttributeValue(item, level + 1);
    if (normalized !== undefined) out[name] = normalized;
  }
  return out;
}

/**
 * 自由属性：键值对，值支持 JSON 原语与嵌套的数组 / 对象 ——
 * 前端会按值的类型选择展示形式（文本 / chunk 分块 / JSON 代码块）。
 */
export function normalizeAttributes(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const out = Object.create(null);
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key).trim();
    if (!name) continue;
    const normalized = normalizeAttributeValue(value, 1);
    if (normalized !== undefined) out[name] = normalized;
  }
  return out;
}

export function normalizeNamespace(raw = {}, index = 0) {
  return {
    id: asString(raw.id) || newId('ns'),
    name: asString(raw.name, '未命名命名空间') || '未命名命名空间',
    description: asString(raw.description),
    order: asOrder(raw.order, index),
  };
}

/**
 * 服务记录的模型字段（顺序即写盘顺序）。
 * 其余顶层键一律视为「自定义字段」：原样保留到数据文件，面板既不解析也不展示，
 * 因此数据文件可以承载面板还不认识的信息，而不会在读写往返中丢失。
 */
export const SITE_FIELDS = [
  'id',
  'namespaceId',
  'name',
  'url',
  'description',
  'icon',
  'tags',
  'status',
  'attributes',
  'order',
  'enabled',
];

/** v1 遗留键：读取时映射到 namespaceId，写盘时不再保留 */
const LEGACY_SITE_FIELDS = ['groupId'];

/** 是否是服务自己的字段（含 v1 遗留键）：其余顶层键按自定义字段处理 */
export function isSiteField(key) {
  return SITE_FIELDS.includes(key) || LEGACY_SITE_FIELDS.includes(key);
}

/**
 * 把自定义顶层字段原样挂到记录上。
 *
 * 用 `defineProperty` 而不是赋值：`__proto__` 这类键也会成为普通自有属性，
 * 不会改写对象原型（与属性容器使用无原型对象是同一个考虑）。
 */
export function applyExtraFields(target, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return target;
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key).trim();
    if (!name || isSiteField(name)) continue;
    Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return target;
}

export function normalizeSite(raw = {}, index = 0) {
  return applyExtraFields(
    {
      id: asString(raw.id) || newId('s'),
      // v1 字段名为 groupId，这里兼容读取
      namespaceId: asString(raw.namespaceId) || asString(raw.groupId),
      name: asString(raw.name, '未命名服务') || '未命名服务',
      url: asString(raw.url),
      description: asString(raw.description),
      icon: asString(raw.icon),
      tags: Array.isArray(raw.tags) ? raw.tags.filter((tag) => typeof tag === 'string') : [],
      status: SITE_STATUSES.includes(raw.status) ? raw.status : 'running',
      attributes: normalizeAttributes(raw.attributes),
      order: asOrder(raw.order, index),
      enabled: asBool(raw.enabled, true),
    },
    raw,
  );
}

/** 归一化一个分区里的条目数组 */
function normalizeItems(raw, normalize) {
  return (Array.isArray(raw) ? raw : []).map(normalize);
}

/**
 * 汇总各分区为一份内存数据（接口层与前端看到的形态）。
 * 服务若指向不存在的命名空间，会回落到第一个命名空间，避免服务「消失」。
 */
export function combineSections({ settings, namespaces, sites }, updatedAt = new Date().toISOString()) {
  const normalizedNamespaces = normalizeItems(namespaces, normalizeNamespace);
  const knownIds = new Set(normalizedNamespaces.map((namespace) => namespace.id));
  const normalizedSites = normalizeItems(sites, normalizeSite).map((site) =>
    knownIds.has(site.namespaceId) ? site : { ...site, namespaceId: normalizedNamespaces[0]?.id ?? '' },
  );

  return {
    version: SCHEMA_VERSION,
    updatedAt,
    settings: normalizeSettings(settings),
    namespaces: normalizedNamespaces,
    sites: normalizedSites,
  };
}

/**
 * 索引：把「按 id / 按归属定位」从线性查找降为 O(1)。
 * 只服务于**定位**（写入前的查找、详情接口），不负责展示顺序（顺序见 sortedView）。
 *
 * 索引指向传入数据里的对象本身：一旦增删了数组元素它就失效，
 * 因此调用方应当「先定位、后增删」（Store 每次写入后都会重建）。
 */
export function createIndex(data) {
  const namespacesById = new Map();
  const sitesById = new Map();
  const sitesByNamespace = new Map();

  for (const namespace of data.namespaces ?? []) {
    namespacesById.set(namespace.id, namespace);
    sitesByNamespace.set(namespace.id, []);
  }
  for (const site of data.sites ?? []) {
    sitesById.set(site.id, site);
    // 归属尚未登记的命名空间时也建桶，保证任何服务都能被定位到
    if (!sitesByNamespace.has(site.namespaceId)) sitesByNamespace.set(site.namespaceId, []);
    sitesByNamespace.get(site.namespaceId).push(site);
  }

  return { namespacesById, sitesById, sitesByNamespace };
}

/** 命名空间下的服务数（索引查找，未收录即 0） */
export function countInIndex(index, namespaceId) {
  return index.sitesByNamespace.get(namespaceId)?.length ?? 0;
}

function byOrder(a, b) {
  if (a.order !== b.order) return a.order - b.order;
  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}

/** 统计每个命名空间下的服务数量 */
export function countSitesByNamespace(sites) {
  const counts = new Map();
  for (const site of sites) {
    counts.set(site.namespaceId, (counts.get(site.namespaceId) ?? 0) + 1);
  }
  return counts;
}

/** 按状态汇总服务数量 */
export function countSitesByStatus(sites) {
  const counts = { running: 0, stopped: 0, coming: 0, developing: 0 };
  for (const site of sites) {
    if (counts[site.status] === undefined) counts[site.status] = 0;
    counts[site.status] += 1;
  }
  return counts;
}

/** 排序后的命名空间与服务视图（供只读接口使用） */
export function sortedView(data) {
  return {
    ...data,
    namespaces: [...data.namespaces].sort(byOrder),
    sites: [...data.sites].sort(byOrder),
  };
}
