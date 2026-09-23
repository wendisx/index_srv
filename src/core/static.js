/**
 * 静态资源服务：src/web 下的 HTML/CSS/JS/SVG。
 * 支持 ETag 协商缓存、目录默认文档、路径穿越防护。
 */
import fs from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { notFound, httpError } from './errors.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function contentTypeFor(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

async function statOrNull(filePath) {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

export function createStaticHandler({ dir, index = 'index.html', maxAge = 0 }) {
  const root = path.resolve(dir);

  return async function serveStatic(req, res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      throw httpError(400, 'bad_request', '非法的请求路径');
    }

    let filePath = path.resolve(root, rel.replace(/^\/+/, ''));
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      throw httpError(403, 'forbidden', '禁止访问该路径');
    }

    let info = await statOrNull(filePath);
    if (info?.isDirectory()) {
      filePath = path.join(filePath, index);
      info = await statOrNull(filePath);
    }
    if (!info?.isFile()) {
      // 未命中具体文件时回退到单页入口（仅限非静态资源后缀请求）
      if (!path.extname(rel)) {
        const fallback = path.join(root, index);
        const fallbackInfo = await statOrNull(fallback);
        if (!fallbackInfo) throw notFound('页面不存在');
        filePath = fallback;
        info = fallbackInfo;
      } else {
        throw notFound('静态资源不存在');
      }
    }

    const etag = `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
    const headers = {
      'content-type': contentTypeFor(filePath),
      'cache-control': maxAge > 0 ? `public, max-age=${maxAge}` : 'no-cache',
      etag,
      'last-modified': info.mtime.toUTCString(),
    };

    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      res.end();
      return true;
    }

    res.writeHead(200, { ...headers, 'content-length': info.size });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res);
    });
    return true;
  };
}
