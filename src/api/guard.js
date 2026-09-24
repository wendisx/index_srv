/**
 * 服务密钥校验与写操作鉴权。
 *
 * 密钥来源：环境变量 INDEX_SRV_SECRET。服务启动时立即转成 SHA-256 摘要，
 * 内存里只留摘要 —— 明文既不落配置文件，也不参与比较。
 * 客户端提交的同样是摘要（十六进制小写），两侧用定长比较，避免时序侧信道。
 *
 * 未配置密钥时无人能取得 super 权限，因此**写操作一律拒绝**（接口为只读）。
 *
 * 网段约束：`server.digestAllowlistEnabled`（默认 true）为真时，摘要链路同样要求
 * 来源落在 `server.permissionAllowlist` 内 —— 密钥泄漏后，非信任来源即便拿到摘要
 * 也写不进来；只有必须从公网 IP 写入时才关掉它。
 */
import { timingSafeEqual } from 'node:crypto';
import { forbidden, unauthorized } from '../core/errors.js';
import { clientIp, forwardedHeaders } from '../core/http.js';
import { isIpAllowed } from '../core/net.js';

/** SHA-256 十六进制摘要 */
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 从请求头中提取客户端提交的摘要：x-service-digest 或 Authorization: Bearer */
export function extractDigest(headers = {}) {
  const direct = headers['x-service-digest'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim().toLowerCase();
  const authorization = headers.authorization ?? '';
  const [scheme, value] = authorization.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim().toLowerCase() : undefined;
}

/** 摘要格式是否合法（用于入参校验，避免把任意串拿去比较） */
export function isDigestFormat(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

/** 请求携带的摘要是否与服务端一致（未配置密钥时恒为 false） */
export function verifyDigest(config, headers) {
  const expected = config.auth?.secretDigest;
  if (!expected) return false;
  const provided = extractDigest(headers ?? {});
  return Boolean(provided) && safeEqual(provided, expected);
}

/**
 * 来源是否走「可信网段免密钥」通道：白名单内 + 开关打开。
 *
 * 用途：浏览器在**非安全上下文**（`http://内网IP`）下不提供 Web Crypto，算不出摘要，
 * 也就无法提权与写入（客户端会直接拒绝，连请求都不发）。开启该通道后，白名单内的
 * 来源无需摘要即视为 super —— 凭据从「密钥」变成「来源网段」，请只在内网可信时开启。
 */
export function isTrustedSource(config, req) {
  return Boolean(config.server?.trustedNetworkBypass) && isIpAllowed(config.server?.permissionAllowlist, clientIp(req, config.server?.trustedProxies));
}

/** 摘要链路被网段拦下时的留痕：与权限切换日志同一套字段（对端地址 + 转发头） */
function logWriteBlocked(logger, req, config) {
  logger?.warn('写操作被拦下：来源不在白名单内', {
    ip: clientIp(req, config.server?.trustedProxies),
    ...forwardedHeaders(req),
    result: 'block',
    reason: 'allowlist',
  });
}

/**
 * 写操作鉴权：**先看来源网段，再验摘要**。
 *
 * 来源判定与提升接口共用同一份 `server.permissionAllowlist`（默认放行回环与内网段）；
 * 开关 `server.digestAllowlistEnabled` 只影响这里 —— 提升接口始终受约束。
 */
export function requireAuth(ctx) {
  const { config, req, logger } = ctx;

  // 可信网段免密钥：白名单内的来源不必带摘要
  if (isTrustedSource(config, req)) {
    // 没配密钥时仍然只读 ——「未配置密钥 = 只读」的安全默认优先于便利
    if (!config.auth?.secretDigest) {
      throw unauthorized('服务端未配置服务密钥（INDEX_SRV_SECRET），接口为只读');
    }
    logger?.debug('可信网段免密钥放行：写操作', {
      ip: clientIp(req, config.server?.trustedProxies),
      ...forwardedHeaders(req),
      result: 'pass',
      reason: 'trusted-network',
    });
    return;
  }

  if (
    config.server?.digestAllowlistEnabled !== false &&
    !isIpAllowed(config.server?.permissionAllowlist, clientIp(req, config.server?.trustedProxies))
  ) {
    logWriteBlocked(logger, req, config);
    throw forbidden('当前来源地址不在白名单内（server.permissionAllowlist），写操作被拒绝');
  }
  if (!config.auth?.secretDigest) {
    throw unauthorized('服务端未配置服务密钥（INDEX_SRV_SECRET），接口为只读');
  }
  if (!verifyDigest(config, req.headers)) {
    throw unauthorized('写操作需要有效的服务密钥摘要（x-service-digest）');
  }
}
