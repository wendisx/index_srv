/**
 * 入参校验工具：全部抛出 validation_error(422)，details 中带 field 便于前端定位。
 */
import { validationError } from '../core/errors.js';

export function requireString(value, field, { max = 200, min = 1 } = {}) {
  if (typeof value !== 'string') {
    throw validationError(`${field} 必须是字符串`, { field });
  }
  const out = value.trim();
  if (out.length < min) throw validationError(`${field} 不能为空`, { field });
  if (out.length > max) throw validationError(`${field} 长度不能超过 ${max}`, { field });
  return out;
}

export function optionalString(value, field, { max = 500, fallback = '' } = {}) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw validationError(`${field} 必须是字符串`, { field });
  const out = value.trim();
  if (out.length > max) throw validationError(`${field} 长度不能超过 ${max}`, { field });
  return out;
}

export function requireUrl(value, field = 'url') {
  const raw = requireString(value, field, { max: 2048 });
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw validationError(`${field} 不是合法的 URL`, { field });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw validationError(`${field} 仅支持 http/https 协议`, { field });
  }
  return parsed.toString();
}

/** 选填 URL：空值与纯空白都视为「未提供」，其余复用 requireUrl 的同一套校验 */
export function optionalUrl(value, field = 'icon') {
  if (value === undefined || value === null || value === '') return '';
  const raw = optionalString(value, field, { max: 2048 });
  return raw ? requireUrl(raw, field) : '';
}

export function normalizeTags(value, field = 'tags', { max = 20, maxLength = 32 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw validationError(`${field} 必须是字符串数组`, { field });
  const tags = value
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const unique = [...new Set(tags)];
  if (unique.length > max) throw validationError(`${field} 最多 ${max} 个`, { field });
  for (const tag of unique) {
    if (tag.length > maxLength) throw validationError(`${field} 单项长度不能超过 ${maxLength}`, { field });
  }
  return unique;
}

/**
 * 自由属性：对象，键非空且长度受限，值支持 JSON 原语（字符串 / 数字 / 布尔 / null）
 * 以及嵌套的数组与对象 —— 前端按值的类型选择展示形式。
 *
 * 限制与 core/store.js 的读取侧保持同一套语义：层级最深 maxDepth（值本身算第 1 层）、
 * 容器最多 maxItems 项、字符串最长 maxValue。写入侧一旦越界直接报 422，而不是静默丢弃。
 */
export function normalizeAttributes(value, field = 'attributes', options = {}) {
  const limits = {
    max: options.max ?? 50,
    maxKey: options.maxKey ?? 64,
    maxValue: options.maxValue ?? 500,
    maxItems: options.maxItems ?? 50,
    maxDepth: options.maxDepth ?? 4,
  };

  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(`${field} 必须是 JSON 对象`, { field });
  }

  const entries = Object.entries(value);
  if (entries.length > limits.max) {
    throw validationError(`${field} 最多 ${limits.max} 个键`, { field });
  }

  // 无原型对象：__proto__ 这类键只会成为普通键，不会触发原型污染
  const out = Object.create(null);
  for (const [key, raw] of entries) {
    const name = String(key).trim();
    if (!name) throw validationError(`${field} 不允许空键`, { field });
    if (name.length > limits.maxKey) {
      throw validationError(`${field} 的键「${name}」长度不能超过 ${limits.maxKey}`, { field, key: name });
    }
    out[name] = normalizeAttributeValue(raw, { field, path: `${field}.${name}`, limits, level: 1 });
  }
  return out;
}

/** 递归校验单个属性值，path 用于把报错定位到具体键或数组下标 */
function normalizeAttributeValue(raw, { field, path, limits, level }) {
  if (raw === null) return null;

  const type = typeof raw;
  if (type === 'boolean') return raw;
  if (type === 'number') {
    if (!Number.isFinite(raw)) throw validationError(`${path} 不是有效数字`, { field, key: path });
    return raw;
  }
  if (type === 'string') {
    if (raw.length > limits.maxValue) {
      throw validationError(`${path} 长度不能超过 ${limits.maxValue}`, { field, key: path });
    }
    return raw;
  }
  if (type !== 'object') {
    throw validationError(`${path} 不是合法的 JSON 值`, { field, key: path });
  }
  if (level > limits.maxDepth) {
    throw validationError(`${path} 嵌套不能超过 ${limits.maxDepth} 层`, { field, key: path });
  }

  if (Array.isArray(raw)) {
    if (raw.length > limits.maxItems) {
      throw validationError(`${path} 最多 ${limits.maxItems} 个元素`, { field, key: path });
    }
    return raw.map((item, index) =>
      normalizeAttributeValue(item, { field, path: `${path}[${index}]`, limits, level: level + 1 }),
    );
  }

  const entries = Object.entries(raw);
  if (entries.length > limits.maxItems) {
    throw validationError(`${path} 最多 ${limits.maxItems} 个键`, { field, key: path });
  }

  const out = Object.create(null);
  for (const [key, item] of entries) {
    const name = String(key).trim();
    if (!name) throw validationError(`${path} 不允许空键`, { field, key: path });
    if (name.length > limits.maxKey) {
      throw validationError(`${path} 的键「${name}」长度不能超过 ${limits.maxKey}`, { field, key: path });
    }
    out[name] = normalizeAttributeValue(item, { field, path: `${path}.${name}`, limits, level: level + 1 });
  }
  return out;
}

export function optionalBool(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw validationError(`${field} 必须是布尔值`, { field });
  return value;
}

export function optionalEnum(value, field, allowed, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!allowed.includes(value)) {
    throw validationError(`${field} 只能是 ${allowed.join(' / ')}`, { field, allowed });
  }
  return value;
}

export function optionalNumber(value, field, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) throw validationError(`${field} 必须是数字`, { field });
  return num;
}

export function requireObject(value, field = 'body') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(`${field} 必须是 JSON 对象`, { field });
  }
  return value;
}
