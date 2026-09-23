/**
 * 权限级别接口。
 *
 * 级别约定：0 = super（可写），3 = user（只读）
 *
 * 判定规则：
 *   - 服务端未配置 INDEX_SRV_SECRET → 固定 3（secretRequired = false，无法提升）
 *   - 请求携带有效密钥摘要             → 0
 *   - 其它情况                        → 3
 *
 * 前端交互：点击权限组件时，若当前为 3 则弹出密钥输入框、提交摘要后切换为 0；
 * 若当前为 0 则直接清掉本地摘要切回 3（服务端不保存任何会话状态）。
 */
import { unauthorized, validationError } from '../core/errors.js';
import { ok, readJsonBody } from '../core/http.js';
import { isDigestFormat, verifyDigest } from './guard.js';
import { requireObject, requireString } from './validate.js';

export const PERMISSION_SUPER = 0;
export const PERMISSION_USER = 3;

export function resolvePermission(config, headers) {
  const secretRequired = Boolean(config.auth?.secretDigest);

  if (secretRequired && verifyDigest(config, headers)) {
    return { level: PERMISSION_SUPER, role: 'super', secretRequired, reason: 'digest' };
  }
  return {
    level: PERMISSION_USER,
    role: 'user',
    secretRequired,
    reason: secretRequired ? 'anonymous' : 'unconfigured',
  };
}

export function registerPermissionRoutes(router) {
  router.get('/api/permission', ({ res, config, req }) => {
    ok(res, resolvePermission(config, req.headers));
  });

  router.post('/api/permission', async (ctx) => {
    const { req, res, config } = ctx;
    const body = requireObject(await readJsonBody(req, { limit: config.server.requestLimitBytes }));
    const digest = requireString(body.digest, 'digest', { max: 64 });

    if (!isDigestFormat(digest)) {
      throw validationError('digest 必须是密钥的 SHA-256 十六进制摘要', { field: 'digest' });
    }
    if (!config.auth?.secretDigest) {
      throw unauthorized('服务端未配置服务密钥（INDEX_SRV_SECRET），无法提升权限');
    }
    if (!verifyDigest(config, { 'x-service-digest': digest })) {
      throw unauthorized('服务密钥不正确');
    }

    // 与 GET /api/permission 用同一处判定：此处摘要已验证，secretRequired 必为 true
    ok(res, resolvePermission(config, { 'x-service-digest': digest }));
  });
}
