/**
 * 服务密钥摘要：与服务端 core/config.js 使用**同一算法**（SHA-256，十六进制小写）。
 *
 * 为什么在客户端算：明文密钥既不落盘也不进持久化存储，只提交摘要；
 * 服务端同样只保留摘要，两侧比较的是摘要本身。
 *
 * 依赖 Web Crypto（crypto.subtle），浏览器只在**安全上下文**（https / localhost）提供它；
 * 通过局域网明文 HTTP 访问时不可用，调用方需给出提示（见 app.js 的 openModal）。
 */

/** 与服务端 core/config.js 保持一致：SHA-256 十六进制小写 */
const ALGORITHM = 'SHA-256';

/** 当前环境是否提供 Web Crypto（不可用时无法提升权限） */
export function isDigestSupported() {
  return Boolean(globalThis.crypto?.subtle);
}

/**
 * 计算文本的 SHA-256 摘要（十六进制小写，与服务端 node:crypto 的输出一致）。
 * @param {string} text
 * @returns {Promise<string>} 64 个十六进制字符
 */
export async function sha256Hex(text) {
  if (!isDigestSupported()) {
    throw new Error('当前环境不提供 Web Crypto，请改用 https 或 localhost 访问');
  }
  const bytes = new TextEncoder().encode(String(text));
  const buffer = await globalThis.crypto.subtle.digest(ALGORITHM, bytes);
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
