/**
 * 服务（Site）接口：面板中的每条服务索引。
 * v2 起归属字段为 namespaceId，并新增手工状态 status 与自由属性 attributes。
 */
import { conflict, notFound, validationError } from '../core/errors.js';
import { ok, readJsonBody } from '../core/http.js';
import { SITE_STATUSES, applyExtraFields, newId, normalizeSite, sortedView } from '../core/schema.js';
import { requireAuth } from './guard.js';
import {
  normalizeAttributes,
  normalizeTags,
  optionalBool,
  optionalEnum,
  optionalNumber,
  optionalString,
  optionalUrl,
  requireObject,
  requireString,
  requireUrl,
} from './validate.js';

/** 服务不存在时的统一错误 */
const siteNotFound = (id) => notFound(`服务 ${id} 不存在`);

/** 按 id 定位服务（索引 O(1)），未找到抛 404 */
function requireSite(index, id) {
  const site = index.sitesById.get(id);
  if (!site) throw siteNotFound(id);
  return site;
}

/** 归属命名空间必须存在（索引判定，不遍历数组） */
function assertNamespaceExists(index, namespaceId) {
  if (!namespaceId) return;
  if (!index.namespacesById.has(namespaceId)) {
    throw validationError(`命名空间 ${namespaceId} 不存在`, { field: 'namespaceId' });
  }
}

/** 追加到所属命名空间末尾：该空间下最大 order + 1（索引只取同组服务） */
function nextOrder(index, namespaceId) {
  const siblings = index.sitesByNamespace.get(namespaceId) ?? [];
  return siblings.reduce((max, site) => Math.max(max, site.order), -1) + 1;
}

/** 属性值摊平为可搜索文本：容器用紧凑 JSON，保证嵌套内容也能被关键字命中 */
const searchableValue = (value) =>
  value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);

function matchesQuery(site, keyword) {
  if (!keyword) return true;
  const haystack = [
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
  return haystack.includes(keyword.toLowerCase());
}

export function registerSiteRoutes(router) {
  router.get('/api/sites', ({ res, store, query }) => {
    const data = store.snapshot();
    const namespaceFilter = query.get('namespace');
    const tagFilter = query.get('tag');
    const statusFilter = query.get('status');
    const enabledFilter = query.get('enabled');
    const keyword = query.get('q');

    const sites = sortedView(data).sites.filter((site) => {
      if (namespaceFilter && site.namespaceId !== namespaceFilter) return false;
      if (tagFilter && !site.tags.includes(tagFilter)) return false;
      if (statusFilter && site.status !== statusFilter) return false;
      if (enabledFilter === 'true' && !site.enabled) return false;
      if (enabledFilter === 'false' && site.enabled) return false;
      return matchesQuery(site, keyword);
    });

    ok(res, { total: sites.length, items: sites, updatedAt: data.updatedAt });
  });

  // 批量排序需先于 /api/sites/:id 注册
  router.put('/api/sites/order', async (ctx) => {
    const { req, res, config, store } = ctx;
    requireAuth(ctx);
    const body = requireObject(await readJsonBody(req, { limit: config.server.requestLimitBytes }));
    if (!Array.isArray(body.ids)) throw validationError('ids 必须是服务 id 数组', { field: 'ids' });

    const sites = await store.update((draft, index) => {
      body.ids.forEach((id, position) => {
        const site = index.sitesById.get(id);
        if (site) site.order = position;
      });
      return sortedView(draft).sites;
    });

    ok(res, sites);
  });

  router.post('/api/sites', async (ctx) => {
    const { req, res, config, store } = ctx;
    requireAuth(ctx);
    const body = requireObject(await readJsonBody(req, { limit: config.server.requestLimitBytes }));

    const created = await store.update((draft, index) => {
      const id = optionalString(body.id, 'id', { max: 64 }) || newId('s');
      if (index.sitesById.has(id)) {
        throw conflict(`服务 id ${id} 已存在`, { field: 'id' });
      }

      const namespaceId = optionalString(body.namespaceId, 'namespaceId', { max: 64 }) || draft.namespaces[0]?.id || '';
      assertNamespaceExists(index, namespaceId);

      // 先铺开请求体：模型之外的顶层键会被 normalizeSite 当作自定义字段原样保留，
      // 随后的显式字段（校验后的值）覆盖同名键
      const site = normalizeSite(
        {
          ...body,
          id,
          namespaceId,
          name: requireString(body.name, 'name', { max: 64 }),
          url: requireUrl(body.url, 'url'),
          description: optionalString(body.description, 'description', { max: 200 }),
          icon: optionalUrl(body.icon, 'icon'),
          tags: normalizeTags(body.tags),
          status: optionalEnum(body.status, 'status', SITE_STATUSES, 'running'),
          attributes: normalizeAttributes(body.attributes, 'attributes'),
          order: optionalNumber(body.order, 'order', nextOrder(index, namespaceId)),
          enabled: optionalBool(body.enabled, 'enabled', true),
        },
        draft.sites.length,
      );

      draft.sites.push(site);
      return site;
    });

    ok(res, created, 201);
  });

  router.get('/api/sites/:id', ({ res, store, params }) => {
    // 索引直取，不必为单条记录克隆整份数据
    const site = store.siteById(params.id);
    if (!site) throw siteNotFound(params.id);
    ok(res, site);
  });

  const updateSite = async (ctx) => {
    const { req, res, config, store, params } = ctx;
    requireAuth(ctx);
    const body = requireObject(await readJsonBody(req, { limit: config.server.requestLimitBytes }));

    const updated = await store.update((_draft, index) => {
      const site = requireSite(index, params.id);

      if ('namespaceId' in body) {
        const namespaceId = optionalString(body.namespaceId, 'namespaceId', { max: 64 });
        assertNamespaceExists(index, namespaceId);
        site.namespaceId = namespaceId;
      }
      if ('name' in body) site.name = requireString(body.name, 'name', { max: 64 });
      if ('url' in body) site.url = requireUrl(body.url, 'url');
      if ('description' in body) site.description = optionalString(body.description, 'description', { max: 200 });
      if ('icon' in body) site.icon = optionalUrl(body.icon, 'icon');
      if ('tags' in body) site.tags = normalizeTags(body.tags);
      if ('status' in body) site.status = optionalEnum(body.status, 'status', SITE_STATUSES, site.status);
      if ('attributes' in body) site.attributes = normalizeAttributes(body.attributes, 'attributes');
      if ('order' in body) site.order = optionalNumber(body.order, 'order', site.order);
      if ('enabled' in body) site.enabled = optionalBool(body.enabled, 'enabled', site.enabled);

      // 模型之外的顶层键：原样写回（自定义字段，面板不解析也不展示）
      applyExtraFields(site, body);

      return site;
    });

    ok(res, updated);
  };

  router.put('/api/sites/:id', updateSite);
  router.patch('/api/sites/:id', updateSite);
}
