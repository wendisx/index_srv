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
import { clientIp, forwardedHeaders, ok, readJsonBody } from '../core/http.js';
import { isIpAllowed } from '../core/net.js';
import { isDigestFormat, isTrustedSource, verifyDigest } from './guard.js';
import { requireObject, requireString } from './validate.js';

export const PERMISSION_SUPER = 0;
export const PERMISSION_USER = 3;

export function resolvePermission(config, headers, trusted = false) {
  const secretRequired = Boolean(config.auth?.secretDigest);

  // 可信网段免密钥：白名单内的来源直接是 super（见 api/guard.js 的 isTrustedSource）。
  // 但仍要求服务端配了密钥 ——「未配置密钥 = 只读」是刻意保留的安全默认，
  // 免密钥通道不该把它悄悄变成可写。
  if (trusted && secretRequired) {
    return { level: PERMISSION_SUPER, role: 'super', secretRequired, reason: 'trusted-network' };
  }
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

/**
 * 权限切换留痕：一条日志同时回答「谁在切」与「切成了什么」。
 *
 *   ip            TCP 对端真实地址（不信任 XFF，见 core/http.js 的 clientIp）
 *   xForwardedFor / xRealIp  请求携带的转发头原样记录 —— 便于和代理链路对照排查
 *   from / to     切换起点与**本次请求的目标级别**（提升接口的目标恒为 0 super；
 *                 被拦下时级别实际没变，是否真的切成了看 result）
 *   result        pass（放行）/ block（拦下）
 *   reason        判定依据：digest / digest-mismatch / allowlist / invalid-digest / unconfigured
 *
 * 消息形如 `权限切换 3 user -> 0 super pass`，被拦下的提升则是 `3 user -> 0 super block`。
 * 放行打 info，拦下打 warn —— 被拒的提升是需要被注意的事件。
 */
function logSwitch(logger, req, config, { from, to, result, reason }) {
  const message = `权限切换 ${from.level} ${from.role} -> ${to.level} ${to.role} ${result}`;
  const fields = {
    ip: clientIp(req, config.server?.trustedProxies),
    ...forwardedHeaders(req),
    result,
    reason,
  };
  if (result === 'pass') logger?.info(message, fields);
  else logger?.warn(message, fields);
}

export function registerPermissionRoutes(router) {
  router.get('/api/permission', ({ res, config, req }) => {
    ok(res, resolvePermission(config, req.headers, isTrustedSource(config, req)));
  });

  router.post('/api/permission', async (ctx) => {
    const { req, res, config, logger } = ctx;
    // 该请求自身不带凭据（摘要只出现在请求体里），所以切换起点恒为匿名 user、目标恒为 0 super；
    // 被拦下时级别其实没变 —— 日志里是否真的切成了由 result 表达
    const anonymous = { level: PERMISSION_USER, role: 'user' };
    const target = { level: PERMISSION_SUPER, role: 'super' };

    // 可信网段免密钥：白名单内的来源不必提交摘要（http 下客户端根本算不出来），
    // 因此连请求体都不读 —— 这条通道的凭据就是「来源网段」
    if (isTrustedSource(config, req)) {
      if (!config.auth?.secretDigest) {
        logSwitch(logger, req, config, { from: anonymous, to: target, result: 'block', reason: 'unconfigured' });
        throw unauthorized('服务端未配置服务密钥（INDEX_SRV_SECRET），无法提升权限');
      }
      logSwitch(logger, req, config, { from: anonymous, to: target, result: 'pass', reason: 'trusted-network' });
      ok(res, resolvePermission(config, {}, true));
      return;
    }

    // 来源白名单先于密钥校验：非白名单来源不该进入密钥比对流程，
    // 顺带避免把「摘要格式对不对」这类信息回给它们
    if (!isIpAllowed(config.server?.permissionAllowlist, clientIp(req, config.server?.trustedProxies))) {
      logSwitch(logger, req, config, { from: anonymous, to: target, result: 'block', reason: 'allowlist' });
      throw forbidden('当前来源地址不在权限提升白名单内（server.permissionAllowlist）');
    }

    const body = requireObject(await readJsonBody(req, { limit: config.server.requestLimitBytes }));
    const digest = requireString(body.digest, 'digest', { max: 64 });

    if (!isDigestFormat(digest)) {
      logSwitch(logger, req, config, { from: anonymous, to: target, result: 'block', reason: 'invalid-digest' });
      throw validationError('digest 必须是密钥的 SHA-256 十六进制摘要', { field: 'digest' });
    }
    if (!config.auth?.secretDigest) {
      logSwitch(logger, req, config, { from: anonymous, to: target, result: 'block', reason: 'unconfigured' });
      throw unauthorized('服务端未配置服务密钥（INDEX_SRV_SECRET），无法提升权限');
    }
    if (!verifyDigest(config, { 'x-service-digest': digest })) {
      logSwitch(logger, req, config, { from: anonymous, to: target, result: 'block', reason: 'digest-mismatch' });
      throw unauthorized('服务密钥不正确');
    }

    // 与 GET /api/permission 用同一处判定：此处摘要已验证，secretRequired 必为 true
    const resolved = resolvePermission(config, { 'x-service-digest': digest });
    logSwitch(logger, req, config, {
      from: anonymous,
      to: { level: resolved.level, role: resolved.role },
      result: 'pass',
      reason: 'digest',
    });
    ok(res, resolved);
  });
}
