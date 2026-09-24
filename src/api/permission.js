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
 * 提升入口的来源限制：`server.permissionAllowlist`（IP / CIDR，空 = 不限制）非空时，
 * **POST /api/permission 只接受白名单内的来源**（403），其余来源连密钥比对都不进入 ——
 * 这样即使密钥泄露，非信任网段也无法借提升接口换取 super 会话级别。
 * 注意白名单约束的是「提升」这个动作：写操作本身仍以摘要为准（见 docs/api.md）。
 *
 * 前端交互：点击权限组件时，若当前为 3 则弹出密钥输入框、提交摘要后切换为 0；
 * 若当前为 0 则直接清掉本地摘要切回 3（服务端不保存任何会话状态）。
 */
import { forbidden, unauthorized, validationError } from '../core/errors.js';
import { clientIp, ok, readJsonBody } from '../core/http.js';
import { isIpAllowed } from '../core/net.js';
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

    // 来源白名单先于密钥校验：非白名单来源不该进入密钥比对流程，
    // 顺带避免把「摘要格式对不对」这类信息回给它们
    if (!isIpAllowed(config.server?.permissionAllowlist, clientIp(req))) {
      throw forbidden('当前来源地址不在权限提升白名单内（server.permissionAllowlist）');
    }

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
