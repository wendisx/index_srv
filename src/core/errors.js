/**
 * 统一的 HTTP 错误类型与构造函数。
 * 业务层直接 throw，由 server 统一转换为 { ok: false, error } 响应体。
 */
export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message ?? code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const httpError = (status, code, message, details) =>
  new HttpError(status, code, message, details);

export const badRequest = (message, details) => httpError(400, 'bad_request', message, details);
export const unauthorized = (message = '缺少或无效的访问令牌') =>
  httpError(401, 'unauthorized', message);
export const forbidden = (message = '操作被拒绝') => httpError(403, 'forbidden', message);
export const notFound = (message = '资源不存在') => httpError(404, 'not_found', message);
export const conflict = (message, details) => httpError(409, 'conflict', message, details);
export const validationError = (message, details) =>
  httpError(422, 'validation_error', message, details);
