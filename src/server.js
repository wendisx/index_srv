/**
 * index-srv 服务入口。
 *
 * 职责：
 *  1. 加载配置、初始化日志与数据存储；
 *  2. 将 /api/* 交给路由处理，其余请求交给 src/web 静态资源；
 *  3. 统一错误响应与访问日志；
 *  4. 响应 SIGTERM/SIGINT 做优雅退出（适配 docker stop 与本地 Ctrl-C）。
 */
import http from 'node:http';
import { loadConfig } from './core/config.js';
import { HttpError, httpError, notFound } from './core/errors.js';
import { applyCommonHeaders, applyCors, clientIp, fail } from './core/http.js';
import { createLogger } from './core/logger.js';
import { Router } from './core/router.js';
import { createStaticHandler } from './core/static.js';
import { Store } from './core/store.js';
import { registerApiRoutes } from './api/index.js';

const config = loadConfig();
const logger = createLogger({
  level: config.log.level,
  logDir: config.storage.logDir,
  toStdout: config.log.toStdout,
  toFile: config.log.toFile,
});

// 草稿骨架的来源必须留痕：运维改了 data/conf/service.schema.json 却没生效时，
// 一眼就能看出是「文件没找到」还是「文件内容不可用」，不必去猜。
logger.info('新建服务模板已就绪', {
  file: config.storage.serviceSchemaFile,
  source: config.serviceSchemaSource,
  ...(config.serviceSchemaDetail ? { detail: config.serviceSchemaDetail } : {}),
});

// 可信网段免密钥会改变权限模型的凭据（网段取代密钥），必须在启动日志里显式可见，
// 免得「为什么内网不用密钥就能写」变成一个没人知道的既有事实
if (config.server.trustedNetworkBypass) {
  logger.warn('可信网段免密钥已启用：白名单内的来源无需服务密钥即可提权与写入', {
    allowlist: config.server.permissionAllowlist,
  });
}

const store = new Store({
  dirs: { conf: config.storage.confDir, section: config.storage.sectionDir },
  legacyFile: config.storage.legacyFile,
  logger,
});
try {
  await store.init();
} catch (error) {
  logger.error('数据初始化失败，服务退出', { message: error.message });
  process.exit(1);
}

const router = new Router();
registerApiRoutes(router);

const serveStatic = createStaticHandler({
  dir: config.web.dir,
  index: config.web.index,
  maxAge: config.web.cacheMaxAge,
});

function handleError(error, res) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (error instanceof HttpError) {
    fail(res, error.status, error.code, error.message, error.details);
    return;
  }
  logger.error('未捕获的请求异常', { message: error.message, stack: error.stack });
  fail(res, 500, 'internal_error', '服务内部错误');
}

async function handleRequest(req, res) {
  const startedAt = process.hrtime.bigint();
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.access({
      time: new Date().toISOString(),
      method: req.method,
      path: pathname,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: clientIp(req, config.server.trustedProxies),
    });
  });

  applyCommonHeaders(res);

  try {
    const isApi = pathname === '/api' || pathname.startsWith('/api/');
    if (isApi) {
      if (applyCors(req, res, config)) return;
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { allow: 'GET,POST,PUT,PATCH,DELETE,OPTIONS' });
        res.end();
        return;
      }

      const matched = router.match(req.method, pathname);
      if (!matched) {
        throw notFound(`接口 ${req.method} ${pathname} 不存在`);
      }
      if (matched.allow) {
        res.setHeader('allow', matched.allow.join(', '));
        throw httpError(405, 'method_not_allowed', `${pathname} 不支持 ${req.method}`, {
          allow: matched.allow,
        });
      }

      await matched.handler({
        req,
        res,
        method: req.method,
        pathname,
        query: url.searchParams,
        params: matched.params,
        config,
        logger,
        store,
      });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      throw httpError(405, 'method_not_allowed', '静态资源仅支持 GET/HEAD');
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    handleError(error, res);
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => handleError(error, res));
});

server.on('clientError', (error, socket) => {
  logger.warn('客户端连接异常', { message: error.message });
  socket.destroy();
});

server.listen(config.server.port, config.server.host, () => {
  const { host, port } = config.server;
  logger.info(`${config.name} v${config.version} 已启动`, {
    listen: `${host}:${port}`,
    web: config.web.dir,
    data: config.storage.dataDir,
    configFile: config.configFile,
    secretRequired: Boolean(config.auth.secretDigest),
  });
  process.stdout.write(
    [
      '',
      `  index-srv v${config.version}`,
      `  UI      http://127.0.0.1:${port}/`,
      `  API     http://127.0.0.1:${port}/api/health`,
      `  Web     ${config.web.dir}`,
      `  Data    ${config.storage.dataDir}`,
      `  Auth    ${
        config.auth.secretDigest
          ? '已配置服务密钥（写操作需 x-service-digest）'
          : '未配置 INDEX_SRV_SECRET（接口只读）'
      }`,
      '',
    ].join('\n'),
  );
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`收到 ${signal}，开始优雅退出`);

  const timer = setTimeout(() => {
    logger.warn('优雅退出超时，强制结束进程');
    process.exit(1);
  }, 5000);
  timer.unref();

  server.close(() => {
    logger.close();
    clearTimeout(timer);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('未处理的 Promise 拒绝', { message: String(reason) });
});
