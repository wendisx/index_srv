/**
 * 面板设置（标题、默认主题、强调色等）。
 */
import { ok, readJsonBody } from '../core/http.js';
import { THEMES, normalizeSettings } from '../core/schema.js';
import { requireAuth } from './guard.js';
import { optionalBool, optionalEnum, optionalString, requireObject } from './validate.js';

export function registerConfigRoutes(router) {
  router.get('/api/config', ({ res, config, store }) => {
    const data = store.snapshot();
    ok(res, {
      settings: data.settings,
      runtime: {
        name: config.name,
        version: config.version,
        uptimeSeconds: Math.round(process.uptime()),
        startedAt: config.startedAt.toISOString(),
        secretRequired: Boolean(config.auth.secretDigest),
        configFile: config.configFile,
        // 新建服务草稿骨架的来源：file（用了配置文件）/ default（文件缺失）/ invalid（文件不可用）
        serviceSchemaFile: config.storage.serviceSchemaFile,
        serviceSchemaSource: config.serviceSchemaSource,
        // 三份分区文件的绝对路径（settings / namespaces / sites）
        dataFiles: store.files,
      },
    });
  });

  router.put('/api/config', async (ctx) => {
    const { req, res, config, store } = ctx;
    requireAuth(ctx);
    const body = requireObject(await readJsonBody(req, { limit: config.server.requestLimitBytes }));

    const updated = await store.update((draft) => {
      const next = { ...draft.settings };

      if ('title' in body) next.title = optionalString(body.title, 'title', { max: 64, fallback: '' }) || next.title;
      if ('description' in body) next.description = optionalString(body.description, 'description', { max: 200 });
      if ('theme' in body) next.theme = optionalEnum(body.theme, 'theme', THEMES, next.theme);
      if ('accent' in body) next.accent = optionalString(body.accent, 'accent', { max: 24, fallback: '' }) || next.accent;
      if ('showDescription' in body) next.showDescription = optionalBool(body.showDescription, 'showDescription', next.showDescription);
      if ('showTags' in body) next.showTags = optionalBool(body.showTags, 'showTags', next.showTags);
      if ('openInNewTab' in body) next.openInNewTab = optionalBool(body.openInNewTab, 'openInNewTab', next.openInNewTab);

      draft.settings = normalizeSettings(next);
      return draft.settings;
    });

    ok(res, updated);
  });
}
