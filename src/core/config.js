/**
 * 服务配置加载器。
 *
 * 优先级：src/config/default.json -> 环境变量（供容器与本地部署覆盖）。
 * 约定：所有 src 相关的配置集中在 src/config/，运行期数据（配置内容、日志）
 * 统一落在 data/ 目录，便于 docker-compose 直接挂载本地文件系统。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SERVICE_SCHEMA, normalizeServiceSchema } from './schema.js';

const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SRC_DIR = path.resolve(CORE_DIR, '..');
export const PROJECT_DIR = path.resolve(SRC_DIR, '..');

const DEFAULT_CONFIG_FILE = path.join(SRC_DIR, 'config', 'default.json');

function env(name) {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`无法加载配置文件 ${file}: ${error.message}`);
  }
}

/**
 * 读取「新建服务的草稿骨架」：与 settings.json 同属 conf/ 的**配置类**文件，
 * 供运维手工扩展（加一个字段，新建服务的草稿里就会多一个占位）。
 *
 * 只在启动时读一次 —— 因此改完要重启服务才生效，与 data/ 下其它文件一致。
 * 走「文件优先、内置兜底」：缺失或不是 JSON 对象都不影响启动，
 * 但会把来源与原因如实带出去（启动日志与 /api/config 的 runtime 里都能看到）。
 *
 * @returns {{ schema: object, source: 'file'|'default'|'invalid', detail?: string }}
 */
function readServiceSchema(file) {
  if (!fs.existsSync(file)) return { schema: DEFAULT_SERVICE_SCHEMA, source: 'default' };
  try {
    const schema = normalizeServiceSchema(readJsonFile(file));
    if (schema) return { schema, source: 'file' };
    return { schema: DEFAULT_SERVICE_SCHEMA, source: 'invalid', detail: '顶层必须是 JSON 对象' };
  } catch (error) {
    return { schema: DEFAULT_SERVICE_SCHEMA, source: 'invalid', detail: error.message };
  }
}

function toPort(value, fallback) {
  const port = Number.parseInt(value ?? '', 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function toPositiveInt(value, fallback) {
  const num = Number.parseInt(value ?? '', 10);
  return Number.isInteger(num) && num >= 0 ? num : fallback;
}

function splitList(value) {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 服务密钥摘要：密钥只从环境变量 INDEX_SRV_SECRET 读取，且只在启动时读一次，
 * 立即转成 SHA-256 摘要 —— 明文既不落配置文件也不留在内存；未配置时返回 null，
 * 此时权限固定为 user(3)，写操作一律拒绝。
 */
function serviceSecretDigest() {
  const secret = env('INDEX_SRV_SECRET');
  return secret ? createHash('sha256').update(secret, 'utf8').digest('hex') : null;
}

export function loadConfig() {
  const configFile = env('INDEX_SRV_CONFIG')
    ? path.resolve(env('INDEX_SRV_CONFIG'))
    : DEFAULT_CONFIG_FILE;

  if (!fs.existsSync(configFile)) {
    throw new Error(`配置文件不存在: ${configFile}`);
  }

  const base = readJsonFile(configFile);
  const rootDir = path.resolve(env('INDEX_SRV_ROOT') ?? PROJECT_DIR);

  const dataDir = path.resolve(rootDir, env('INDEX_SRV_DATA_DIR') ?? base.storage.dataDir);
  const serviceSchemaFile = path.resolve(
    dataDir,
    base.storage.serviceSchemaFile ?? 'conf/service.schema.json',
  );
  const service = readServiceSchema(serviceSchemaFile);
  const envOrigins = splitList(env('INDEX_SRV_CORS_ORIGINS'));
  const fileOrigins = Array.isArray(base.server?.cors?.origins) ? base.server.cors.origins : [];

  return {
    name: base.name ?? 'index-srv',
    version: base.version ?? '0.0.0',
    configFile,
    startedAt: new Date(),
    server: {
      host: env('INDEX_SRV_HOST') ?? base.server.host,
      port: toPort(env('INDEX_SRV_PORT'), base.server.port),
      requestLimitBytes: toPositiveInt(
        env('INDEX_SRV_REQUEST_LIMIT'),
        base.server.requestLimitBytes ?? 262144,
      ),
      cors: {
        enabled: envOrigins.length > 0 || Boolean(base.server?.cors?.enabled),
        origins: envOrigins.length > 0 ? envOrigins : fileOrigins,
      },
    },
    storage: {
      dataDir,
      logDir: path.resolve(dataDir, env('INDEX_SRV_LOG_DIR') ?? base.storage.logDir),
      // 数据按语义分区存放：配置类在 conf/，数据源在 section/（均相对 dataDir）
      confDir: path.resolve(dataDir, base.storage.confDir ?? 'conf'),
      sectionDir: path.resolve(dataDir, base.storage.sectionDir ?? 'section'),
      // 旧版单文件：只在分区缺失时作为迁移来源，迁移完成后可删除
      legacyFile: base.storage.legacyConfFile
        ? path.resolve(dataDir, base.storage.legacyConfFile)
        : null,
      // 新建服务的草稿骨架（配置类文件，只在启动时读一次，见 readServiceSchema）
      serviceSchemaFile,
      // 说明文档（data/intro 下的 Markdown）：既可以是目录也可以是单文件，
      // 形态在启动时探测一次（见 introMode），前端据此决定弹窗是否带 sidebar
      // 说明文档：目录（多篇）或单个 .md（一篇）；单文件必须是 .md，
      // 免得配置误指向 settings.json 之类时被当成文档发出去
      introPath: path.resolve(dataDir, env('INDEX_SRV_INTRO') ?? base.storage.introPath ?? 'intro'),
    },
    // 草稿骨架本体与来源：source 取 file / default / invalid，由 /api/config 与启动日志透出
    serviceSchema: service.schema,
    serviceSchemaSource: service.source,
    ...(service.detail ? { serviceSchemaDetail: service.detail } : {}),
    web: {
      dir: path.resolve(rootDir, env('INDEX_SRV_WEB_DIR') ?? base.web.dir),
      index: base.web.index ?? 'index.html',
      cacheMaxAge: toPositiveInt(env('INDEX_SRV_WEB_CACHE'), base.web.cacheMaxAge ?? 0),
    },
    auth: {
      // 只保留摘要：比较用的凭据是客户端提交的摘要，明文密钥不进入配置对象
      secretDigest: serviceSecretDigest(),
    },
    log: {
      level: env('INDEX_SRV_LOG_LEVEL') ?? base.log?.level ?? 'info',
      toStdout: base.log?.toStdout !== false,
      toFile: base.log?.toFile !== false,
    },
  };
}
