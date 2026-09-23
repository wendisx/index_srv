/**
 * 健康检查与运行时元信息。
 */
import { ok } from '../core/http.js';

export function registerHealthRoutes(router) {
  router.get('/api/health', ({ res, config }) => {
    ok(res, {
      status: 'ok',
      name: config.name,
      version: config.version,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: config.startedAt.toISOString(),
      time: new Date().toISOString(),
      node: process.version,
    });
  });
}
