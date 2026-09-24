/**
 * 网络地址判定（纯函数，便于单测）。
 *
 * 用途：`server.permissionAllowlist` 的 IP / CIDR 匹配 —— 只有来自白名单网段的
 * 请求才允许调用**权限提升**接口（见 `api/permission.js`）。
 *
 * 支持的写法：
 *   - 单个 IPv4：`192.168.1.10`
 *   - IPv4 网段：`192.168.1.0/24`（前缀 0–32）
 *   - IPv6：按完整地址精确匹配（不做 IPv6 网段匹配）
 * 归一化：Node 在双栈 socket 上会把 IPv4 客户端报成 `::ffff:192.168.1.10`，
 * 这里统一折回 IPv4 再比较 —— 否则最常见的「只放行局域网」会永远匹配不上。
 */

/** 去掉空白与 IPv4-mapped 前缀（::ffff:1.2.3.4 → 1.2.3.4） */
export function normalizeIp(value) {
  const ip = String(value ?? '').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1] : ip;
}

/** 点分十进制 → 32 位无符号整数；非法写法返回 null */
function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** 单条规则（`IP` 或 `IP/前缀`）是否命中 */
function matchRule(rule, ip) {
  const [base, bits] = String(rule ?? '').trim().split('/');
  if (bits === undefined) return normalizeIp(base) === ip;

  const size = Number(bits);
  const value = ipv4ToInt(ip);
  const baseValue = ipv4ToInt(normalizeIp(base));
  // 写坏的规则（IPv6 网段、前缀越界、非法地址）一律当作不命中，而不是抛错
  if (value === null || baseValue === null || !Number.isInteger(size) || size < 0 || size > 32) {
    return false;
  }
  const mask = size === 0 ? 0 : (0xffffffff << (32 - size)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

/**
 * 白名单判定：列表为空（或不是数组）表示**不限制** —— 这是默认配置，
 * 保证既有部署升级后行为不变；一旦填了规则，只有命中任一规则的来源才放行。
 */
export function isIpAllowed(allowlist, rawIp) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  const ip = normalizeIp(rawIp);
  if (!ip) return false;
  return allowlist.some((rule) => matchRule(rule, ip));
}
