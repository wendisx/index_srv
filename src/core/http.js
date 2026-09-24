/**
 * HTTP 请求/响应工具：统一响应体、JSON 解析、公共安全头与 CORS。
 *
 * 统一响应体：
 *   成功 { "ok": true,  "data": ... }
 *   失败 { "ok": false, "error": { "code": "...", "message": "...", "details": ... } }
 */
import { badRequest, httpError } from './errors.js';
import { resolveClientIp } from './net.js'; 

const JSON_TYPE = 'application/json; charset=utf-8';

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function ok(res, data, status = 200) {
  sendJson(res, status, { ok: true, data });
}

export function fail(res, status, code, message, details) {
  sendJson(res, status, {
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  });
}

export function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

/**
 * 读取并解析 JSON 请求体；空请求体视为 {}。
 */
export async function readJsonBody(req, { limit = 262144 } = {}) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw httpError(413, 'payload_too_large', `请求体超过限制 ${limit} 字节`);
    }
    chunks.push(chunk);
  }

  if (size === 0) return {};

  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw badRequest('请求体必须是 JSON 对象');
    }
    return parsed;
  } catch (error) {
    if (error.code) throw error;
    throw badRequest('请求体不是合法的 JSON', { reason: error.message });
  }
}

export function applyCommonHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
}

/**
 * 按配置为 /api 路由附加 CORS 头，并处理预检请求。
 * @returns {boolean} 是否已处理（预检请求已结束响应）
 */
export function applyCors(req, res, config) {
  const cors = config.server.cors;
  const origin = req.headers.origin;
  if (!cors.enabled || !origin) return false;

  const allowed = cors.origins.length === 0 || cors.origins.includes('*') || cors.origins.includes(origin);
  if (!allowed) return false;

  res.setHeader('access-control-allow-origin', cors.origins.includes('*') ? '*' : origin);
  res.setHeader('vary', 'Origin');
  // 只声明路由器真正支持的方法（项目无删除接口，见 docs/api.md）
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'content-type,authorization,x-service-digest,x-requested-with',
  );
  res.setHeader('access-control-max-age', '600');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

/**
 * 请求的来源地址（白名单判定用的就是它）。
 *
 * 默认取 TCP 对端地址：`X-Forwarded-For` 可被客户端随意伪造，不采信。
 * 部署在反向代理之后时，把代理地址填进 `server.trustedProxies` —— 只有来自这些
 * 地址的请求才会按 XFF 还原真实客户端（走法见 core/net.js 的 resolveClientIp）。
 */
export function clientIp(req, trustedProxies = []) {
  return resolveClientIp(req?.socket?.remoteAddress ?? '', req?.headers?.['x-forwarded-for'], trustedProxies);
}

/**
 * 请求携带的转发头（原样返回，没有的字段不出现）。
 * 只用于日志对照代理链路，**不参与任何判定** —— 它可以被客户端随意伪造。
 */
export function forwardedHeaders(req) {
  const headers = req?.headers ?? {};
  return {
    ...(headers['x-forwarded-for'] ? { xForwardedFor: headers['x-forwarded-for'] } : {}),
    ...(headers['x-real-ip'] ? { xRealIp: headers['x-real-ip'] } : {}),
  };
}

export function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}
