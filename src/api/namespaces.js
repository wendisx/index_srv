/**
 * 命名空间（Namespace）接口：即左侧目录，服务的一级归属（原 groups，v2 起改名）。
 */
import { conflict, notFound } from '../core/errors.js';
import { ok, readJsonBody } from '../core/http.js';
import { countInIndex, newId, normalizeNamespace, sortedView } from '../core/schema.js';
import { requireAuth } from './guard.js';
import { optionalNumber, optionalString, requireObject, requireString } from './validate.js';

/** 命名空间不存在时的统一错误 */
const namespaceNotFound = (id) => notFound(`命名空间 ${id} 不存在`);

/** 按 id 定位命名空间（索引 O(1)），未找到抛 404 */
function requireNamespace(index, id) {
  const namespace = index.namespacesById.get(id);
  if (!namespace) throw namespaceNotFound(id);
  return namespace;
}

function nextOrder(namespaces) {
  return namespaces.reduce((max, namespace) => Math.max(max, namespace.order), -1) + 1;
}

/** 附上每个命名空间的服务数；countOf 由调用方提供（索引 O(1)，不遍历服务列表） */
const withCounts = (namespaces, countOf) =>
  namespaces.map((namespace) => ({ ...namespace, serviceCount: countOf(namespace.id) }));

export function registerNamespaceRoutes(router) {
  router.get('/api/namespaces', ({ res, store }) => {
    const namespaces = sortedView(store.snapshot()).namespaces;
    ok(res, withCounts(namespaces, (id) => store.countSitesOf(id)));
  });

  // 批量排序需先于 /api/namespaces/:id 注册
  router.put('/api/namespaces/order', async (ctx) => {
    const { req, res, config, store } = ctx;
    requireAuth(ctx);
    const body = requireObject(await readJsonBody(req, { limit: config.server.requestLimitBytes }));
    if (!Array.isArray(body.ids)) throw conflict('ids 必须是命名空间 id 数组');

    const namespaces = await store.update((draft, index) => {
      body.ids.forEach((id, position) => {
        const namespace = index.namespacesById.get(id);
        if (namespace) namespace.order = position;
      });
      return withCounts(sortedView(draft).namespaces, (id) => countInIndex(index, id));
    });

    ok(res, namespaces);
  });

  router.post('/api/namespaces', async (ctx) => {
    const { req, res, config, store } = ctx;
    requireAuth(ctx);
    const body = requireObject(await readJsonBody(req, { limit: config.server.requestLimitBytes }));

    const created = await store.update((draft, index) => {
      const id = optionalString(body.id, 'id', { max: 64 }) || newId('ns');
      if (index.namespacesById.has(id)) {
        throw conflict(`命名空间 id ${id} 已存在`, { field: 'id' });
      }

      const namespace = normalizeNamespace(
        {
          id,
          name: requireString(body.name, 'name', { max: 64 }),
          description: optionalString(body.description, 'description', { max: 200 }),
          order: optionalNumber(body.order, 'order', nextOrder(draft.namespaces)),
        },
        draft.namespaces.length,
      );

      draft.namespaces.push(namespace);
      return namespace;
    });

    ok(res, created, 201);
  });

  router.get('/api/namespaces/:id', ({ res, store, params }) => {
    // 索引直取，不必为单条记录克隆整份数据
    const namespace = store.namespaceById(params.id);
    if (!namespace) throw namespaceNotFound(params.id);
    ok(res, { ...namespace, serviceCount: store.countSitesOf(namespace.id) });
  });

  const updateNamespace = async (ctx) => {
    const { req, res, config, store, params } = ctx;
    requireAuth(ctx);
    const body = requireObject(await readJsonBody(req, { limit: config.server.requestLimitBytes }));

    const updated = await store.update((_draft, index) => {
      const namespace = requireNamespace(index, params.id);
      if ('name' in body) namespace.name = requireString(body.name, 'name', { max: 64 });
      if ('description' in body) {
        namespace.description = optionalString(body.description, 'description', { max: 200 });
      }
      if ('order' in body) namespace.order = optionalNumber(body.order, 'order', namespace.order);
      return namespace;
    });

    ok(res, updated);
  };

  router.put('/api/namespaces/:id', updateNamespace);
  router.patch('/api/namespaces/:id', updateNamespace);
}
