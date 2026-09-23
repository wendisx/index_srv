/**
 * /api 路由注册入口。新增接口只需在此追加 register 调用。
 */
import { registerBackupRoutes } from './backup.js';
import { registerConfigRoutes } from './config.js';
import { registerHealthRoutes } from './health.js';
import { registerNamespaceRoutes } from './namespaces.js';
import { registerNavRoutes } from './nav.js';
import { registerPermissionRoutes } from './permission.js';
import { registerSiteRoutes } from './sites.js';

export function registerApiRoutes(router) {
  registerHealthRoutes(router);
  registerPermissionRoutes(router);
  registerConfigRoutes(router);
  registerNamespaceRoutes(router);
  registerSiteRoutes(router);
  registerNavRoutes(router);
  registerBackupRoutes(router);
}
