/**
 * 导航聚合接口：首屏只需一次请求即可完成渲染（设置 + 权限 + 目录 + 服务 + 统计）。
 */
import { ok } from '../core/http.js';
import { countSitesByNamespace, countSitesByStatus, sortedView } from '../core/schema.js';
import { isTrustedSource } from './guard.js';
import { resolvePermission } from './permission.js';

export function registerNavRoutes(router) {
  router.get('/api/nav', ({ res, store, config, req }) => {
    const data = store.snapshot();
    const view = sortedView(data);
    const sites = view.sites.filter((site) => site.enabled);
    const byNamespace = countSitesByNamespace(sites);
    const byStatus = countSitesByStatus(sites);

    ok(res, {
      settings: data.settings,
      // 新建服务的草稿骨架：随首屏一起下发，编辑器不必再发一次请求
      serviceSchema: config.serviceSchema,
      permission: resolvePermission(config, req.headers, isTrustedSource(config, req)),
      namespaces: view.namespaces.map((namespace) => ({
        ...namespace,
        serviceCount: byNamespace.get(namespace.id) ?? 0,
      })),
      sites,
      stats: {
        namespaces: view.namespaces.length,
        services: sites.length,
        disabledServices: view.sites.length - sites.length,
        running: byStatus.running ?? 0,
        stopped: byStatus.stopped ?? 0,
        coming: byStatus.coming ?? 0,
        developing: byStatus.developing ?? 0,
        updatedAt: data.updatedAt,
      },
    });
  });
}
