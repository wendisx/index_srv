/**
 * 数据备份/导入：整份配置的导出与覆盖式导入，便于迁移与版本管理。
 */
import { validationError } from '../core/errors.js';
import { ok, readJsonBody } from '../core/http.js';
import { requireAuth } from './guard.js';
import { requireObject } from './validate.js';

/**
 * 兼容两种导入载荷：
 *   1. GET /api/store 的完整响应 { ok, data }
 *   2. 数据本体 { version, settings, namespaces, sites }
 */
function unwrapPayload(body) {
  const { ok: flag, data } = body;
  if (flag === true && data && typeof data === 'object' && !Array.isArray(data)) return data;
  return body;
}

export function registerBackupRoutes(router) {
  router.get('/api/store', ({ res, store }) => {
    ok(res, store.snapshot());
  });

  router.put('/api/store', async (ctx) => {
    const { req, res, config, store, logger } = ctx;
    requireAuth(ctx);

    const body = unwrapPayload(
      requireObject(await readJsonBody(req, { limit: config.server.requestLimitBytes })),
    );

    // namespaces 兼容 v1 备份的 groups 键
    const namespaces = body.namespaces !== undefined ? body.namespaces : body.groups;
    const provided = ['settings', namespaces !== undefined ? 'namespaces' : null, 'sites'].filter(
      (key) => key && body[key] !== undefined,
    );
    if (provided.length === 0) {
      throw validationError('导入数据需包含 settings / namespaces / sites 中的至少一个字段', {
        expected: ['settings', 'namespaces', 'sites'],
      });
    }
    if (namespaces !== undefined && !Array.isArray(namespaces)) {
      throw validationError('namespaces 必须是数组', { field: 'namespaces' });
    }
    if (body.sites !== undefined && !Array.isArray(body.sites)) {
      throw validationError('sites 必须是数组', { field: 'sites' });
    }

    await store.replace(body);
    const data = store.snapshot();
    logger.info('数据已通过 API 覆盖导入', {
      fields: provided,
      namespaces: data.namespaces.length,
      sites: data.sites.length,
    });

    ok(res, {
      replaced: provided,
      namespaces: data.namespaces.length,
      sites: data.sites.length,
      updatedAt: data.updatedAt,
    });
  });
}
