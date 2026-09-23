/**
 * 服务密钥校验与写操作鉴权。
 *
 * 密钥来源：环境变量 INDEX_SRV_SECRET。服务启动时立即转成 SHA-256 摘要，
 * 内存里只留摘要 —— 明文既不落配置文件，也不参与比较。
 * 客户端提交的同样是摘要（十六进制小写），两侧用定长比较，避免时序侧信道。
 *
 * 未配置密钥时无人能取得 super 权限，因此**写操作一律拒绝**（接口为只读）。
 */
import { timingSafeEqual } from 'node:crypto';
import { unauthorized } from '../core/errors.js';

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

export function requireAuth(ctx) {
  const { config, req } = ctx;
  if (!config.auth?.secretDigest) {
    throw unauthorized('服务端未配置服务密钥（INDEX_SRV_SECRET），接口为只读');
  }
  if (!verifyDigest(config, req.headers)) {
    throw unauthorized('写操作需要有效的服务密钥摘要（x-service-digest）');
  }
}
