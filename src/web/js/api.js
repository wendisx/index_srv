/**
 * /api 客户端：统一响应体解包与错误抛出。
 *
 * 服务端响应约定：{ ok: true, data } / { ok: false, error: { code, message, details } }
 * 鉴权约定：服务端配置 INDEX_SRV_SECRET 时，写操作与权限提升需要密钥的摘要，
 * setDigest() 后自动带上 x-service-digest —— 客户端只保存摘要，明文密钥不落盘。
 */

const API_BASE = '/api';
const DIGEST_KEY = 'index-srv:digest';

function readStoredDigest() {
  try {
    return window.localStorage.getItem(DIGEST_KEY) || '';
  } catch (error) {
    return '';
  }
}

let digest = readStoredDigest();

const json = (method) => (path, body) =>
  request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function request(path, options = {}) {
  const headers = { accept: 'application/json', ...(options.headers || {}) };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (digest) headers['x-service-digest'] = digest;

  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (error) {
    throw new Error(`无法连接服务：${error.message}`);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`响应解析失败（HTTP ${response.status}）`);
    }
  }

  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error?.message || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }

  return payload?.data ?? null;
}

const put = json('PUT');
const post = json('POST');

export const api = {
  /* 只读接口 */
  nav: () => request('/nav'),
  config: () => request('/config'),
  health: () => request('/health'),
  store: () => request('/store'),
  permission: () => request('/permission'),
  listSites: (query = '') => request(`/sites${query}`),
  listNamespaces: () => request('/namespaces'),

  /* 说明文档：目录形态返回列表，单篇返回 Markdown 原文（渲染在前端做） */
  introIndex: () => request('/intro'),
  introDoc: (id) => request(`/intro/${encodeURIComponent(id)}`),

  /* 权限提升：提交密钥摘要（见 digest.js 的 sha256Hex），是否保存由调用方决定 */
  elevate: (digestValue) => post('/permission', { digest: digestValue }),

  /* 设置 */
  saveConfig: (patch) => put('/config', patch),

  /* 服务 */
  createSite: (site) => post('/sites', site),
  updateSite: (id, patch) => put(`/sites/${encodeURIComponent(id)}`, patch),
  reorderSites: (ids) => put('/sites/order', { ids }),

  /* 命名空间 */
  createNamespace: (namespace) => post('/namespaces', namespace),
  updateNamespace: (id, patch) => put(`/namespaces/${encodeURIComponent(id)}`, patch),
  reorderNamespaces: (ids) => put('/namespaces/order', { ids }),

  /* 整份导入导出 */
  replaceStore: (data) => put('/store', data),

  setDigest(value) {
    digest = value || '';
    try {
      if (digest) window.localStorage.setItem(DIGEST_KEY, digest);
      else window.localStorage.removeItem(DIGEST_KEY);
    } catch (error) {
      /* 忽略持久化失败 */
    }
  },

  getDigest: () => digest,
};
