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

/** 地址是否落在可信代理列表内（列表为空 = 没有可信代理，任何 XFF 都不采信） */
function isTrustedProxy(trustedProxies, ip) {
  if (!Array.isArray(trustedProxies) || trustedProxies.length === 0) return false;
  return isIpAllowed(trustedProxies, ip);
}

/**
 * 解析请求的**真实客户端地址**：只在「直连对端本身是可信代理」时才采信
 * `X-Forwarded-For`，否则一律用 socket 地址。
 *
 * 为什么必须两者结合：前置反向代理（nginx）后，socket 对端恒为代理地址，白名单会
 * 整体失效；而 XFF 又完全由客户端可控，无条件采信等于把白名单交给伪造者。
 *
 * 采信时**只取最右一项**（= 我方代理用 `$proxy_add_x_forwarded_for` 追加的那一跳、
 * 也就是它亲眼看到的对端），**不向左回溯**。回溯看起来更「精确」（能穿过多级代理），
 * 但它会踩到一个真实陷阱：当最右项本身落在可信代理网段内时（多级代理，或 Docker
 * 把宿主机来源改写成网桥网关 `172.x.0.1`），继续往左找到的地址已经进入客户端自带的
 * 那段，于是**伪造的头反而被当成真实客户端**（实测过：伪造 `X-Forwarded-For: 10.99.9.9`
 * 就能通过只放行 `10.99.9.9/32` 的白名单）。宁可粗一点，也不把白名单交给伪造者。
 *
 * 代价与应对：多级代理时拿到的是紧邻的那台代理地址 —— 把它的地址写进
 * `permissionAllowlist` 即可（或让最外层代理直接对客户端负责）。
 */
export function resolveClientIp(rawPeerIp, forwardedFor, trustedProxies = []) {
  const peer = normalizeIp(rawPeerIp);
  if (!isTrustedProxy(trustedProxies, peer)) return peer;

  const chain = String(forwardedFor ?? '')
    .split(',')
    .map((item) => normalizeIp(item))
    .filter(Boolean);
  // XFF 缺失时回落到 socket 地址（对端可信但没带 XFF，说明它没启用反代头）
  return chain.at(-1) ?? peer;
}
