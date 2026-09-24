/**
 * 端到端冒烟：用临时数据目录在随机端口启动服务，校验页面、静态资源、接口与鉴权链路。
 *
 * 覆盖静态检查与渲染快照都测不到的那一层：服务还起不起得来、新增的前端模块有没有漏投放、
 * 路径穿越防护与协商缓存是否仍然有效、以及权限切换的完整链路。
 *
 * 两种启动模式：
 *   1. 未配置 INDEX_SRV_SECRET —— 权限固定 3（只读），写操作一律拒绝
 *   2. 配置 INDEX_SRV_SECRET=123456 —— 提交密钥摘要可提升为 super，写操作放行
 *
 * 全部使用临时目录与随机端口，不触碰仓库内的 data/。
 *
 * 用法：node tests/check-server.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DEFAULT_SERVICE_SCHEMA } from '../src/core/schema.js';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEST_SECRET = '123456';
const digestOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const bad = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 让内核分配一个空闲端口，避免与开发中的实例冲突 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/** 按原始路径发起请求：fetch 会按 URL 规范归一化 ../，测穿越必须绕开它 */
const rawGet = (port, rawPath) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });

async function waitForHealth(base, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 尚未就绪，继续等待 */
    }
    await sleep(120);
  }
  return false;
}

function walk(dir, base = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(base, entry.name);
    return entry.isDirectory() ? walk(path.join(dir, entry.name), rel) : [rel];
  });
}

/** 数据目录下的三份分区文件（相对路径） */
const SECTION_FILES = ['conf/settings.json', 'section/namespace.json', 'section/service.json'];

/**
 * 新建服务的草稿骨架（配置类文件）。它不是 store 的分区，不参与「一次写操作只落盘
 * 一份文件」的断言，但服务启动时会读它，因此播种时要一并放进临时目录。
 */
const SERVICE_SCHEMA_REL = 'conf/service.schema.json';

/** 读取某个数据目录里的分区文件 */
const readDataFile = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));

/** 仓库自带数据（作为播种来源，不直接使用仓库目录） */
const readRepoData = (rel) => readDataFile(path.join(ROOT, 'data'), rel);

/** 把仓库里的某个数据文件复制进临时数据目录 */
function copyRepoData(dataDir, rel) {
  fs.mkdirSync(path.dirname(path.join(dataDir, rel)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'data', rel), path.join(dataDir, rel));
}

/** 默认播种：把仓库的三份分区文件与草稿骨架复制进临时目录 */
function seedSections(dataDir) {
  for (const rel of SECTION_FILES) copyRepoData(dataDir, rel);
  copyRepoData(dataDir, SERVICE_SCHEMA_REL);
}

/** 运维扩展过的草稿骨架：含自定义字段、嵌套结构与一个应当被忽略的 namespaceId */
const CUSTOM_SCHEMA = {
  owner: 'ops',
  name: '',
  url: '',
  自定义: { 嵌套: [1, 2] },
  namespaceId: '应被忽略',
};

/** 播种：分区文件照旧，草稿骨架用上面这份自定义模板 */
function seedCustomSchema(dataDir) {
  seedSections(dataDir);
  fs.writeFileSync(path.join(dataDir, SERVICE_SCHEMA_REL), `${JSON.stringify(CUSTOM_SCHEMA, null, 2)}\n`);
}

/** 播种：草稿骨架是坏 JSON（运维最容易犯的错），用于验证回落与留痕 */
function seedBrokenSchema(dataDir) {
  seedSections(dataDir);
  fs.writeFileSync(path.join(dataDir, SERVICE_SCHEMA_REL), '{ 这不是合法 JSON');
}

/** 播种：说明文档是一个目录（data/intro 下的 md） */
function seedIntroDir(dataDir) {
  seedSections(dataDir);
  const source = path.join(ROOT, 'data', 'intro');
  const target = path.join(dataDir, 'intro');
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(source)) {
    fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
  // 额外播种一篇 hidden 文档：侧栏必须把它过滤掉，但单篇接口仍可访问
  fs.writeFileSync(
    path.join(target, '99-archived.md'),
    ['---', "label: '已归档的旧文档'", 'order: 9', 'hidden: true', '---', '', '# 已归档', '', '这篇不应出现在侧栏。', ''].join('\n'),
  );
  // 再播种一篇没有 frontmatter 的旧式文档：必须按缺省处理（排最后、展示名回落文件名）
  fs.writeFileSync(path.join(target, 'legacy.md'), '# 旧式文档\n\n没有 frontmatter 也能读。\n');
}

/**
 * 播种：说明路径指向单个 .md 文件（而不是目录）。
 * 文件名带 .md 后缀是刻意的：服务端只认 markdown 文件作说明，
 * 这样配置误指向 settings.json 之类时不会被当成文档发出去。
 */
const INTRO_FILE = 'single.md';

function seedIntroFile(dataDir) {
  seedSections(dataDir);
  fs.writeFileSync(
    path.join(dataDir, INTRO_FILE),
    ['---', "label: '单文件说明'", 'order: 1', 'hidden: false', '---', '', '# 单文件说明', '', '只有一篇，前端不应渲染目录栏。', ''].join('\n'),
  );
}

/** 旧版播种：只放单文件 conf/sites.json（把三份分区合并回 v2 形态），用于验证启动迁移 */
function seedLegacy(dataDir) {
  const legacy = {
    version: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
    settings: readRepoData('conf/settings.json').settings,
    namespaces: readRepoData('section/namespace.json').namespaces,
    sites: readRepoData('section/service.json').services,
  };
  fs.mkdirSync(path.join(dataDir, 'conf'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'conf', 'sites.json'), `${JSON.stringify(legacy, null, 2)}\n`);
}

/** 断言一次写操作只落盘了预期的那一份分区文件 */
function assertOnlyChanged(before, after, expected, label) {
  for (const rel of SECTION_FILES) {
    const changed = before[rel] !== after[rel];
    if (changed !== (rel === expected)) {
      bad.push(`${label} 后 ${rel} ${changed ? '被写入' : '未写入'}（期望${rel === expected ? '' : '不'}写入）`);
    }
  }
}

/** 起一个实例跑一段校验，结束后必定收尾（含临时数据目录） */
async function withServer(extraEnv, run, { seed = seedSections } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'index-srv-test-'));
  seed(dataDir);

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      INDEX_SRV_PORT: String(port),
      INDEX_SRV_DATA_DIR: dataDir,
      INDEX_SRV_LOG_LEVEL: 'error',
      INDEX_SRV_SECRET: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverOutput = '';
  server.stdout.on('data', (chunk) => {
    serverOutput += chunk;
  });
  server.stderr.on('data', (chunk) => {
    serverOutput += chunk;
  });

  try {
    if (!(await waitForHealth(base))) {
      throw new Error(`服务未在 10 秒内就绪：\n${serverOutput}`);
    }
    await run({ base, port, dataDir });
  } finally {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        server.kill('SIGKILL');
        resolve();
      }, 5000);
      server.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      server.kill('SIGTERM');
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

const jsonHeaders = { 'content-type': 'application/json' };
const permissionOf = async (base, headers = {}) => (await (await fetch(`${base}/api/permission`, { headers })).json()).data;

/* ---------------- 模式一：未配置密钥，接口只读 ---------------- */

async function checkReadOnlyMode() {
  await withServer({}, async ({ base, port, dataDir }) => {
    /* 页面入口 */
    const page = await fetch(`${base}/`);
    if (page.status !== 200) bad.push(`GET / 返回 ${page.status}`);
    if (!/text\/html/.test(page.headers.get('content-type') ?? '')) bad.push('GET / 的 content-type 不是 text/html');
    const pageHtml = await page.text();
    for (const marker of ['data-theme', 'tpl-namespace', 'icons/sprite.svg', 'js/app.js', 'perm-modal']) {
      if (!pageHtml.includes(marker)) bad.push(`页面 HTML 缺少 ${marker}`);
    }

    /* src/web 下每个文件都必须可访问（新增前端模块漏投放会被这里拦住） */
    for (const rel of walk(path.join(ROOT, 'src', 'web'))) {
      const res = await fetch(`${base}/${rel}`);
      if (res.status !== 200) bad.push(`静态资源 /${rel} 返回 ${res.status}`);
    }

    /* 未配置密钥：权限固定 3，且无法提升 */
    const permission = await permissionOf(base);
    if (permission.level !== 3) bad.push(`未配置密钥时权限应为 3，实际 ${permission.level}`);
    if (permission.secretRequired !== false) bad.push('未配置密钥时 secretRequired 应为 false');
    const elevate = await fetch(`${base}/api/permission`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ digest: digestOf(TEST_SECRET) }),
    });
    if (elevate.status !== 401) bad.push(`未配置密钥时提升权限应 401，实际 ${elevate.status}`);

    /* 写操作一律拒绝（即便带上任意摘要） */
    for (const [label, headers] of [
      ['不带摘要', {}],
      ['带任意摘要', { 'x-service-digest': digestOf(TEST_SECRET) }],
    ]) {
      const res = await fetch(`${base}/api/config`, {
        method: 'PUT',
        headers: { ...jsonHeaders, ...headers },
        body: JSON.stringify({ title: 'x' }),
      });
      if (res.status !== 401) bad.push(`未配置密钥时写操作（${label}）应 401，实际 ${res.status}`);
    }

    /* 接口与数据一致性 */
    const health = await (await fetch(`${base}/api/health`)).json();
    if (health.ok !== true) bad.push('/api/health 未返回 ok:true');
    const nav = await (await fetch(`${base}/api/nav`)).json();
    const services = readDataFile(dataDir, 'section/service.json').services;
    const namespaces = readDataFile(dataDir, 'section/namespace.json').namespaces;
    const enabledSites = services.filter((site) => site.enabled !== false).length;
    if (nav.data?.stats?.services !== enabledSites) {
      bad.push(`/api/nav 服务数 ${nav.data?.stats?.services} 与数据文件（${enabledSites}）不符`);
    }
    if (nav.data?.stats?.namespaces !== namespaces.length) {
      bad.push(`/api/nav 命名空间数 ${nav.data?.stats?.namespaces} 与数据文件（${namespaces.length}）不符`);
    }

    /* 新建服务的草稿骨架：随首屏下发，内容与仓库里的配置文件一致 */
    if (JSON.stringify(nav.data?.serviceSchema) !== JSON.stringify(readRepoData(SERVICE_SCHEMA_REL))) {
      bad.push(`/api/nav 下发的 serviceSchema 与 data/${SERVICE_SCHEMA_REL} 不一致`);
    }
    const runtimeInfo = (await (await fetch(`${base}/api/config`)).json()).data?.runtime ?? {};
    if (runtimeInfo.serviceSchemaSource !== 'file') {
      bad.push(`草稿骨架来源应为 file，实际 ${runtimeInfo.serviceSchemaSource}`);
    }
    // runtime 是运维接口：docs/api.md 里承诺的键必须真实存在（曾出现过文档写 authRequired、
    // 代码发 secretRequired 的漂移，这里按字段清单兜住这类「改了代码忘了文档」）
    for (const key of [
      'name',
      'version',
      'uptimeSeconds',
      'startedAt',
      'secretRequired',
      'configFile',
      'serviceSchemaFile',
      'serviceSchemaSource',
      'dataFiles',
    ]) {
      if (!(key in runtimeInfo)) bad.push(`/api/config 的 runtime 缺少文档承诺的字段 ${key}`);
    }

    /* 删除接口在任何权限下都不存在：路由层直接 405，而不是 401 */
    const deleteAttempt = await fetch(`${base}/api/sites/s-grafana`, { method: 'DELETE' });
    if (deleteAttempt.status !== 405) bad.push(`只读模式下 DELETE 也应 405，实际 ${deleteAttempt.status}`);

    /* 未知接口与路径穿越 */
    const missing = await fetch(`${base}/api/nope`);
    if (missing.status !== 404) bad.push(`未知接口应返回 404，实际 ${missing.status}`);

    // 断言的是「读不到站外文件」这一性质，而不是某个具体状态码：
    // 明文 ../ 会在 URL 解析阶段被归一化掉（落到 404），百分号编码的则会被拒绝（403）。
    const traversals = [
      { path: '/%2e%2e%2fpackage.json', marker: '"private": true' },
      { path: '/..%2fpackage.json', marker: '"private": true' },
      { path: '/../readme.md', marker: '# index srv' },
      { path: '/%2e%2e%2fdata%2fsection%2fservice.json', marker: '"services"' },
      { path: '/..%2fdata%2fconf%2fsettings.json', marker: '"settings"' },
    ];
    for (const { path: rawPath, marker } of traversals) {
      const { status, body } = await rawGet(port, rawPath);
      if (status === 200) bad.push(`路径穿越 ${rawPath} 返回了 200`);
      if (body.includes(marker)) bad.push(`路径穿越 ${rawPath} 读到了站外文件内容`);
    }

    /* 协商缓存 */
    const first = await fetch(`${base}/css/theme.css`);
    const etag = first.headers.get('etag');
    if (!etag) bad.push('静态资源缺少 etag');
    else {
      const second = await fetch(`${base}/css/theme.css`, { headers: { 'if-none-match': etag } });
      if (second.status !== 304) bad.push(`带 If-None-Match 应返回 304，实际 ${second.status}`);
    }
  });
}

/* ---------------- 模式二：配置密钥，走完整鉴权链路 ---------------- */

async function checkSecretMode() {
  const digest = digestOf(TEST_SECRET);
  const authHeaders = { 'x-service-digest': digest };

  await withServer({ INDEX_SRV_SECRET: TEST_SECRET }, async ({ base, dataDir }) => {
    /* 带摘要访问 /api/nav：应识别为 super，且响应里不出现明文密钥、也不回显摘要 */
    const nav = await (await fetch(`${base}/api/nav`, { headers: authHeaders })).json();
    const navText = JSON.stringify(nav);
    if (nav.data?.permission?.level !== 0) bad.push('/api/nav 未按摘要识别为 super');
    if (navText.includes(TEST_SECRET)) bad.push('/api/nav 响应中出现了明文密钥');
    if (navText.includes(digest)) bad.push('/api/nav 响应中回显了摘要');

    /* 未带摘要：3；带摘要：0 */
    const anonymous = await permissionOf(base);
    if (anonymous.level !== 3 || anonymous.secretRequired !== true) {
      bad.push(`不带摘要应为 user(3)/secretRequired=true，实际 ${JSON.stringify(anonymous)}`);
    }
    const elevated = await permissionOf(base, authHeaders);
    if (elevated.level !== 0 || elevated.role !== 'super') {
      bad.push(`带有效摘要应为 super(0)，实际 ${JSON.stringify(elevated)}`);
    }
    // Authorization: Bearer 同样接受
    const bearer = await permissionOf(base, { authorization: `Bearer ${digest}` });
    if (bearer.level !== 0) bad.push('Authorization: Bearer 摘要未被接受');

    /* 提升接口：正确摘要 200 / 错误摘要 401 / 非法格式 422 */
    const correct = await fetch(`${base}/api/permission`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ digest }),
    });
    if (correct.status !== 200) bad.push(`提交正确摘要应 200，实际 ${correct.status}`);
    const wrong = await fetch(`${base}/api/permission`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ digest: digestOf('wrong-secret') }),
    });
    if (wrong.status !== 401) bad.push(`提交错误摘要应 401，实际 ${wrong.status}`);
    const malformed = await fetch(`${base}/api/permission`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ digest: 'not-a-sha256-digest' }),
    });
    if (malformed.status !== 422) bad.push(`非法摘要格式应 422，实际 ${malformed.status}`);

    /* 写操作：无摘要 401 / 错摘要 401 / 正确摘要 201 */
    const writeBody = JSON.stringify({ title: '鉴权写入' });
    const noDigest = await fetch(`${base}/api/config`, { method: 'PUT', headers: jsonHeaders, body: writeBody });
    if (noDigest.status !== 401) bad.push(`无摘要写操作应 401，实际 ${noDigest.status}`);
    const wrongDigest = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { ...jsonHeaders, 'x-service-digest': digestOf('nope') },
      body: writeBody,
    });
    if (wrongDigest.status !== 401) bad.push(`错误摘要写操作应 401，实际 ${wrongDigest.status}`);
    const writeOk = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { ...jsonHeaders, ...authHeaders },
      body: writeBody,
    });
    if (writeOk.status !== 200) bad.push(`正确摘要写操作应 200，实际 ${writeOk.status}`);

    /* 嵌套属性往返（前端按值类型渲染，依赖数据层不丢信息） */
    const created = await fetch(`${base}/api/sites`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...authHeaders },
      body: JSON.stringify({
        id: 's-nested',
        name: '嵌套属性',
        url: 'http://127.0.0.1:1234',
        namespaceId: 'ns-monitor',
        attributes: {
          list: ['a', 1, true, null],
          map: { host: 'h', deep: { n: [1, 2] } },
          nil: null,
          scalar: 'x',
        },
      }),
    });
    if (created.status !== 201) bad.push(`写入嵌套属性应返回 201，实际 ${created.status}`);

    const stored = await (await fetch(`${base}/api/sites/s-nested`)).json();
    const attributes = stored.data?.attributes ?? {};
    if (JSON.stringify(attributes.list) !== JSON.stringify(['a', 1, true, null])) bad.push('数组属性未原样保存');
    if (attributes.map?.deep?.n?.[1] !== 2) bad.push('深层对象属性未原样保存');
    if (!('nil' in attributes) || attributes.nil !== null) bad.push('null 属性未原样保存');
    if (attributes.scalar !== 'x') bad.push('标量属性未原样保存');

    /* 分区写回：一次写操作只落盘内容确实变化的那一份文件 */
    const snapshotFiles = () =>
      Object.fromEntries(SECTION_FILES.map((rel) => [rel, fs.readFileSync(path.join(dataDir, rel), 'utf8')]));

    const beforeSettings = snapshotFiles();
    const settingsWrite = await fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { ...jsonHeaders, ...authHeaders },
      body: JSON.stringify({ description: '分区写回探针' }),
    });
    if (settingsWrite.status !== 200) bad.push(`改设置应 200，实际 ${settingsWrite.status}`);
    assertOnlyChanged(beforeSettings, snapshotFiles(), 'conf/settings.json', '改设置');

    const beforeSite = snapshotFiles();
    const siteWrite = await fetch(`${base}/api/sites`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...authHeaders },
      body: JSON.stringify({
        id: 's-partition',
        name: '分区探针',
        url: 'http://127.0.0.1:1',
        namespaceId: 'ns-monitor',
      }),
    });
    if (siteWrite.status !== 201) bad.push(`新增服务应 201，实际 ${siteWrite.status}`);
    assertOnlyChanged(beforeSite, snapshotFiles(), 'section/service.json', '新增服务');

    const beforeNamespace = snapshotFiles();
    const orderWrite = await fetch(`${base}/api/namespaces/order`, {
      method: 'PUT',
      headers: { ...jsonHeaders, ...authHeaders },
      body: JSON.stringify({ ids: ['ns-tools'] }),
    });
    if (orderWrite.status !== 200) bad.push(`命名空间排序应 200，实际 ${orderWrite.status}`);
    assertOnlyChanged(beforeNamespace, snapshotFiles(), 'section/namespace.json', '调整命名空间顺序');

    /* 每份分区文件自带版本与时间戳 */
    for (const rel of SECTION_FILES) {
      const payload = readDataFile(dataDir, rel);
      if (payload.version !== 3) bad.push(`${rel} 的 version 应为 3，实际 ${payload.version}`);
      if (!payload.updatedAt) bad.push(`${rel} 缺少 updatedAt`);
    }

    /* 命名空间：创建后立即可查，且落盘会让 LAST MODIFY（聚合 updatedAt）前进 */
    const beforeCreate = await (await fetch(`${base}/api/nav`)).json();
    const beforeNamespaceFiles = snapshotFiles();
    await sleep(5); // 让写入时间戳与上一次写操作可分辨

    const createNamespace = await fetch(`${base}/api/namespaces`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...authHeaders },
      body: JSON.stringify({ name: '新建命名空间' }),
    });
    if (createNamespace.status !== 201) bad.push(`新建命名空间应 201，实际 ${createNamespace.status}`);
    const namespaceId = (await createNamespace.json()).data?.id;
    if (!namespaceId) bad.push('新建命名空间未返回 id');

    assertOnlyChanged(beforeNamespaceFiles, snapshotFiles(), 'section/namespace.json', '新建命名空间');

    const namespaceList = await (await fetch(`${base}/api/namespaces`)).json();
    const listed = namespaceList.data.find((item) => item.id === namespaceId);
    if (!listed) bad.push('列表接口看不到新建的命名空间');
    else {
      if (listed.name !== '新建命名空间') bad.push(`新建命名空间的名称未保留：${listed.name}`);
      if (listed.serviceCount !== 0) bad.push(`新建命名空间的服务数应为 0，实际 ${listed.serviceCount}`);
    }
    const namespaceDetail = await (await fetch(`${base}/api/namespaces/${namespaceId}`)).json();
    if (namespaceDetail.data?.id !== namespaceId) bad.push('详情接口按 id 取新命名空间失败');

    const afterCreate = await (await fetch(`${base}/api/nav`)).json();
    if (afterCreate.data?.stats?.namespaces !== (beforeCreate.data?.stats?.namespaces ?? 0) + 1) {
      bad.push('新建命名空间后 /api/nav 的命名空间数未增加');
    }
    if (!(new Date(afterCreate.data.stats.updatedAt) > new Date(beforeCreate.data.stats.updatedAt))) {
      bad.push(
        `落盘后 LAST MODIFY 未更新：${beforeCreate.data.stats.updatedAt} → ${afterCreate.data.stats.updatedAt}`,
      );
    }

    /* 删除能力已整体移除：DELETE 一律 405，且尝试之后数据仍在 */
    for (const target of [`/api/sites/s-nested`, `/api/namespaces/${namespaceId}`]) {
      const attempt = await fetch(`${base}${target}`, { method: 'DELETE', headers: { ...jsonHeaders, ...authHeaders } });
      if (attempt.status !== 405) bad.push(`DELETE ${target} 应 405（不支持删除），实际 ${attempt.status}`);
      if (!(attempt.headers.get('allow') ?? '').includes('GET')) bad.push(`DELETE ${target} 的 405 响应缺少 allow 头`);
    }
    for (const target of [`/api/sites/s-nested`, `/api/namespaces/${namespaceId}`]) {
      if ((await fetch(`${base}${target}`)).status !== 200) bad.push(`DELETE 尝试后 ${target} 仍应可读`);
    }

    /* 编辑服务：PUT 局部更新 → 只落盘服务分区 → LAST MODIFY 前进 */
    await sleep(5);
    const beforeEdit = await (await fetch(`${base}/api/nav`)).json();
    const beforeEditFiles = snapshotFiles();
    const editSite = await fetch(`${base}/api/sites/s-nested`, {
      method: 'PUT',
      headers: { ...jsonHeaders, ...authHeaders },
      body: JSON.stringify({ name: '嵌套属性（已改）', status: 'developing' }),
    });
    if (editSite.status !== 200) bad.push(`编辑服务应 200，实际 ${editSite.status}`);
    assertOnlyChanged(beforeEditFiles, snapshotFiles(), 'section/service.json', '编辑服务');

    const edited = await (await fetch(`${base}/api/sites/s-nested`)).json();
    if (edited.data?.name !== '嵌套属性（已改）') bad.push(`编辑后的 name 未生效：${edited.data?.name}`);
    if (edited.data?.status !== 'developing') bad.push(`编辑后的 status 未生效：${edited.data?.status}`);
    if (JSON.stringify(edited.data?.attributes?.list) !== JSON.stringify(['a', 1, true, null])) {
      bad.push('局部更新不应清空未提交的 attributes');
    }

    const afterEdit = await (await fetch(`${base}/api/nav`)).json();
    if (!(new Date(afterEdit.data.stats.updatedAt) > new Date(beforeEdit.data.stats.updatedAt))) {
      bad.push(
        `编辑服务后 LAST MODIFY 未更新：${beforeEdit.data.stats.updatedAt} → ${afterEdit.data.stats.updatedAt}`,
      );
    }

    /* 必填字段非法必须被拒（编辑器保存前也会拦一道，服务端仍要兜底） */
    for (const [label, body] of [
      ['空 name', JSON.stringify({ name: '  ' })],
      ['非 http(s) url', JSON.stringify({ url: 'ftp://127.0.0.1' })],
      ['非法 status', JSON.stringify({ status: 'unknown' })],
    ]) {
      const res = await fetch(`${base}/api/sites/s-nested`, {
        method: 'PUT',
        headers: { ...jsonHeaders, ...authHeaders },
        body,
      });
      if (res.status !== 422) bad.push(`${label} 的编辑应 422，实际 ${res.status}`);
    }

    /* 自定义顶层字段：模型之外的键原样写盘（面板不解析、不展示），新建与编辑都要保住 */
    const extrasCreate = await fetch(`${base}/api/sites`, {
      method: 'POST',
      headers: { ...jsonHeaders, ...authHeaders },
      body: JSON.stringify({
        id: 's-extras',
        name: '自定义字段',
        url: 'http://127.0.0.1:1',
        namespaceId: 'ns-monitor',
        owner: 'ops',
        pinned: true,
        meta: { tier: 2 },
      }),
    });
    if (extrasCreate.status !== 201) bad.push(`带自定义字段的新建应 201，实际 ${extrasCreate.status}`);

    const extrasRead = await (await fetch(`${base}/api/sites/s-extras`)).json();
    if (extrasRead.data?.owner !== 'ops' || extrasRead.data?.pinned !== true) {
      bad.push(`自定义顶层字段未原样返回：${JSON.stringify(extrasRead.data?.owner)}`);
    }
    if (extrasRead.data?.meta?.tier !== 2) bad.push('自定义嵌套字段未原样返回');

    const extrasStored = readDataFile(dataDir, 'section/service.json').services.find((s) => s.id === 's-extras');
    if (extrasStored?.owner !== 'ops' || extrasStored?.meta?.tier !== 2) {
      bad.push('自定义顶层字段未写入数据文件');
    }

    const extrasEdit = await fetch(`${base}/api/sites/s-extras`, {
      method: 'PUT',
      headers: { ...jsonHeaders, ...authHeaders },
      body: JSON.stringify({ description: '改一下', tier: 'gold' }),
    });
    if (extrasEdit.status !== 200) bad.push(`带自定义字段的编辑应 200，实际 ${extrasEdit.status}`);
    const extrasAfterEdit = await (await fetch(`${base}/api/sites/s-extras`)).json();
    if (extrasAfterEdit.data?.owner !== 'ops') bad.push('编辑不应丢掉已有的自定义字段');
    if (extrasAfterEdit.data?.tier !== 'gold') bad.push('编辑新增的自定义字段未写入');

    /* 越界属性必须被拒绝 */
    const rejectSite = { id: 's-reject', name: '越界属性', url: 'http://127.0.0.1:1', namespaceId: 'ns-monitor' };
    const rejectionCases = [
      ['嵌套超过 4 层', JSON.stringify({ ...rejectSite, attributes: { l1: { l2: { l3: { l4: { l5: { l6: 1 } } } } } } })],
      ['数组元素超过 50', JSON.stringify({ ...rejectSite, attributes: { list: Array.from({ length: 51 }, (_, index) => index) } })],
      // 非有限数字只能以溢出字面量到达服务端：JSON.stringify(Infinity) 会先变成 null
      ['非有限数字', '{"id":"s-reject","name":"越界属性","url":"http://127.0.0.1:1","namespaceId":"ns-monitor","attributes":{"num":1e400}}'],
    ];
    for (const [label, body] of rejectionCases) {
      const res = await fetch(`${base}/api/sites`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...authHeaders },
        body,
      });
      if (res.status !== 422) bad.push(`${label} 应返回 422，实际 ${res.status}`);
    }
  });
}

/* ---------------- 模式三：从旧版单文件迁移到分区文件 ---------------- */

async function checkLegacyMigration() {
  await withServer(
    {},
    async ({ base, dataDir }) => {
      /* 迁移应补齐三份分区文件，旧文件原样保留 */
      for (const rel of SECTION_FILES) {
        if (!fs.existsSync(path.join(dataDir, rel))) bad.push(`迁移后缺少分区文件 ${rel}`);
        else if (readDataFile(dataDir, rel).version !== 3) bad.push(`迁移后 ${rel} 的 version 不是 3`);
      }
      if (!fs.existsSync(path.join(dataDir, 'conf', 'sites.json'))) bad.push('迁移不应删除旧版单文件');
      const legacy = readDataFile(dataDir, 'conf/sites.json');

      /* 数据不丢：统计与旧文件一致 */
      const nav = await (await fetch(`${base}/api/nav`)).json();
      const enabled = legacy.sites.filter((site) => site.enabled !== false).length;
      if (nav.data?.stats?.services !== enabled) {
        bad.push(`迁移后服务数 ${nav.data?.stats?.services} 与旧文件 ${enabled} 不符`);
      }
      if (nav.data?.stats?.namespaces !== legacy.namespaces.length) {
        bad.push(`迁移后命名空间数 ${nav.data?.stats?.namespaces} 与旧文件 ${legacy.namespaces.length} 不符`);
      }
      // 迁移只是换了存放形式，不该改动数据自身的时间戳
      if (readDataFile(dataDir, 'section/service.json').updatedAt !== legacy.updatedAt) {
        bad.push('迁移不应刷新数据的时间戳');
      }

      /* 索引定位：详情接口按 id 取单条，未收录的 id 返回 404 */
      const first = legacy.sites[0];
      const site = await (await fetch(`${base}/api/sites/${first.id}`)).json();
      if (site.data?.id !== first.id || site.data?.name !== first.name) bad.push('迁移后按 id 取服务失败');
      if ((await fetch(`${base}/api/sites/nope`)).status !== 404) bad.push('不存在的服务应返回 404');

      const namespaceId = legacy.namespaces[0].id;
      const namespace = await (await fetch(`${base}/api/namespaces/${namespaceId}`)).json();
      const members = (id) =>
        legacy.sites.filter((item) => (item.namespaceId ?? item.groupId) === id).length;
      if (namespace.data?.serviceCount !== members(namespaceId)) {
        bad.push(`命名空间详情 serviceCount 应为 ${members(namespaceId)}，实际 ${namespace.data?.serviceCount}`);
      }
      if ((await fetch(`${base}/api/namespaces/nope`)).status !== 404) bad.push('不存在的命名空间应返回 404');

      /* 列表接口的服务数同样来自索引 */
      const list = await (await fetch(`${base}/api/namespaces`)).json();
      for (const namespace of legacy.namespaces) {
        const found = list.data.find((item) => item.id === namespace.id);
        if (found?.serviceCount !== members(namespace.id)) {
          bad.push(`命名空间列表 ${namespace.id} 计数应为 ${members(namespace.id)}，实际 ${found?.serviceCount}`);
        }
      }

      /* 这个数据目录里没有草稿骨架文件：回落到内置默认，服务照常可用 */
      const runtimeInfo = (await (await fetch(`${base}/api/config`)).json()).data?.runtime ?? {};
      if (runtimeInfo.serviceSchemaSource !== 'default') {
        bad.push(`缺少草稿骨架文件时应回落到 default，实际 ${runtimeInfo.serviceSchemaSource}`);
      }
      const navForSchema = await (await fetch(`${base}/api/nav`)).json();
      if (JSON.stringify(navForSchema.data?.serviceSchema) !== JSON.stringify(DEFAULT_SERVICE_SCHEMA)) {
        bad.push('回落后的草稿骨架与内置默认不一致');
      }
    },
    { seed: seedLegacy },
  );
}

/* ---------------- 模式四：新建服务的草稿骨架可配置 ---------------- */

async function checkServiceSchema() {
  /* 运维扩展过的模板：启动时读入 → 原样下发（自定义字段与嵌套结构都保留） */
  await withServer(
    {},
    async ({ base }) => {
      const nav = await (await fetch(`${base}/api/nav`)).json();
      const sent = nav.data?.serviceSchema;
      const { namespaceId: _ignored, ...expected } = CUSTOM_SCHEMA;
      if (JSON.stringify(sent) !== JSON.stringify(expected)) {
        bad.push(`自定义草稿骨架未被原样下发：${JSON.stringify(sent)}`);
      }
      if (sent && 'namespaceId' in sent) bad.push('下发草稿骨架时未剔除 namespaceId（归属应由点开的命名空间注入）');
      const runtimeInfo = (await (await fetch(`${base}/api/config`)).json()).data?.runtime ?? {};
      if (runtimeInfo.serviceSchemaSource !== 'file') {
        bad.push(`自定义草稿骨架来源应为 file，实际 ${runtimeInfo.serviceSchemaSource}`);
      }
    },
    { seed: seedCustomSchema },
  );

  /* 模板文件是坏 JSON：回落内置默认、来源标记 invalid、服务不因此起不来 */
  await withServer(
    {},
    async ({ base }) => {
      const nav = await (await fetch(`${base}/api/nav`)).json();
      if (JSON.stringify(nav.data?.serviceSchema) !== JSON.stringify(DEFAULT_SERVICE_SCHEMA)) {
        bad.push('损坏的草稿骨架文件未回落到内置默认');
      }
      const runtimeInfo = (await (await fetch(`${base}/api/config`)).json()).data?.runtime ?? {};
      if (runtimeInfo.serviceSchemaSource !== 'invalid') {
        bad.push(`损坏的草稿骨架来源应为 invalid，实际 ${runtimeInfo.serviceSchemaSource}`);
      }
    },
    { seed: seedBrokenSchema },
  );
}

/* ---------------- 模式五：说明文档接口（列表 + 单篇 + 穿越防护） ---------------- */

async function checkIntro() {
  /* 目录形态：列出多篇，单篇返回 Markdown 原文 */
  await withServer(
    {},
    async ({ base, port }) => {
      const index = await (await fetch(`${base}/api/intro`)).json();
      if (index.data?.mode !== 'dir') bad.push(`说明接口形态应为 dir，实际 ${index.data?.mode}`);

      const items = index.data?.items ?? [];
      if (items.length === 0) bad.push('说明接口未列出任何文档');
      else {
        const first = await (await fetch(`${base}/api/intro/${items[0].id}`)).json();
        if (!String(first.data?.content ?? '').startsWith('# ')) {
          bad.push('说明单篇未返回 Markdown 原文');
        }
      }
      // 展示名来自 frontmatter 的 label（不再是正文第一个 # 标题），否则会显示 01-overview 这种
      if (items.some((item) => /^\d+[-_.]/.test(item.name ?? ''))) {
        bad.push('说明展示名未取 frontmatter 的 label：列表里出现了带序号前缀的文件名');
      }
      // 顺序由 order 升序决定、hidden 的不进侧栏；没有 frontmatter 的按缺省处理（排最后、回落文件名）
      // 预期清单：仓库五篇（order 1–5）+ 播种的 legacy.md（无 frontmatter，排最后）；99-archived.md（hidden）不出现
      if (items.map((item) => item.id).join() !== '01-overview.md,02-usage.md,03-deploy.md,04-config.md,05-disclaimer.md,legacy.md') {
        bad.push(`说明列表应按 frontmatter 的 order 升序且过滤 hidden，实际 ${items.map((item) => item.id).join()}`);
      }
      if (items.at(-1)?.name !== 'legacy') {
        bad.push(`无 frontmatter 的文档应回落为文件名展示名并排在最后，实际 ${items.at(-1)?.name}`);
      }
      if (items[0]?.name !== '项目概览') {
        bad.push(`说明展示名应来自 frontmatter 的 label，实际 ${items[0]?.name}`);
      }
      // hidden 只影响侧栏：单篇接口仍可访问，且返回的是剥掉 frontmatter 的正文
      const archived = await (await fetch(`${base}/api/intro/99-archived.md`)).json();
      if (archived.data?.name !== '已归档的旧文档' || !String(archived.data?.content ?? '').startsWith('# 已归档')) {
        bad.push('hidden 文档应仍可通过单篇接口访问（返回剥掉 frontmatter 的正文与 label 展示名）');
      }

      /* 穿越：既不能成功，也不能把 data/conf/settings.json 的内容带出来。
         断言的是「读不到站外文件」这一性质，而不是某个具体状态码。 */
      // 与静态穿越同一套做法：必须用 rawGet，fetch 会按 URL 规范把 ../ 归一化掉，
      // 那样请求根本到不了服务端，测试就成了摆设
      for (const rawPath of [
        '/api/intro/../conf/settings.json',
        '/api/intro/..%2fconf%2fsettings.json',
        '/api/intro/%2e%2e%2fconf%2fsettings.json',
        '/api/intro/../section/service.json',
      ]) {
        const { status, body } = await rawGet(port, rawPath);
        if (status === 200) bad.push(`说明接口穿越未被拦下：${rawPath} 返回 ${status}`);
        if (body.includes('Index Services') || body.includes('"services"')) {
          bad.push(`说明接口泄漏了目录之外的文件内容：${rawPath}`);
        }
      }
    },
    { seed: seedIntroDir },
  );

  /* 单文件形态：只有一篇（用 INDEX_SRV_INTRO 把路径指向单个 .md） */
  await withServer(
    { INDEX_SRV_INTRO: INTRO_FILE },
    async ({ base }) => {
      const index = await (await fetch(`${base}/api/intro`)).json();
      if (index.data?.mode !== 'file') bad.push(`单文件说明形态应为 file，实际 ${index.data?.mode}`);
      const items = index.data?.items ?? [];
      if (items.length !== 1) bad.push(`单文件说明应只列出一篇，实际 ${items.length}`);
      else {
        const doc = await (await fetch(`${base}/api/intro/${items[0].id}`)).json();
        if (!String(doc.data?.content ?? '').includes('单文件说明')) bad.push('单文件说明内容不正确');
        if (doc.data?.name !== '单文件说明') bad.push('单文件说明的展示名应来自 frontmatter 的 label');
        if (/^\s*---/.test(String(doc.data?.content ?? ''))) bad.push('单篇内容不应包含 frontmatter');
      }
    },
    { seed: seedIntroFile },
  );
}

/**
 * 读临时 dataDir 下的应用日志（JSON Lines）。日志是流式写入的，所以允许短轮询；
 * 注意 `INDEX_SRV_LOG_LEVEL=error` 只过滤 stdout，文件始终写 —— 这正是这里能断言的前提。
 */
async function waitForLog(dataDir, predicate, timeoutMs = 2000) {
  const dir = path.join(dataDir, 'log');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const records = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter((file) => file.startsWith('app-'))
          .flatMap((file) =>
            fs
              .readFileSync(path.join(dir, file), 'utf8')
              .split('\n')
              .filter(Boolean)
              .flatMap((line) => {
                try {
                  return [JSON.parse(line)];
                } catch {
                  return [];
                }
              }),
          )
      : [];
    const hit = records.find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  return null;
}

/* ---------------- 模式六：权限提升的来源白名单（server.permissionAllowlist） ---------------- */

/**
 * 白名单只约束「提升」这一个动作：
 *   - 环境变量 INDEX_SRV_PERMISSION_ALLOWLIST 与配置文件 server.permissionAllowlist 两种写法都生效；
 *   - 非白名单来源调 POST /api/permission → 403，且不进入密钥比对；
 *   - GET /api/permission 与写操作仍按摘要判定（白名单不是授权机制，只是提升入口的网段限制）。
 */
async function checkPermissionAllowlist() {
  const digest = digestOf(TEST_SECRET);
  const elevate = (base) =>
    fetch(`${base}/api/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ digest }),
    });
  const write = (base, title) =>
    fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-service-digest': digest },
      body: JSON.stringify({ title }),
    });

  /* ① 环境变量把本机排除在外（白名单只含一个不相干的网段） */
  await withServer(
    { INDEX_SRV_SECRET: TEST_SECRET, INDEX_SRV_PERMISSION_ALLOWLIST: '10.99.0.0/16' },
    async ({ base, dataDir }) => {
      const blocked = await elevate(base);
      if (blocked.status !== 403) bad.push(`白名单外来源提升应 403，实际 ${blocked.status}`);
      else {
        const body = await blocked.json().catch(() => ({}));
        if (body.error?.code !== 'forbidden') {
          bad.push(`白名单外来源提升的错误码应为 forbidden，实际 ${body.error?.code}`);
        }
      }

      const permission = await (
        await fetch(`${base}/api/permission`, { headers: { 'x-service-digest': digest } })
      ).json();
      if (permission.data?.level !== 0) {
        bad.push('白名单不应影响 GET /api/permission 的摘要判定（查询没有副作用）');
      }
      // 摘要链路（写操作）默认同样受白名单约束：摘要有效也写不进来
      const blockedWrite = await write(base, '白名单下的写入');
      if (blockedWrite.status !== 403) {
        bad.push(`白名单外的写操作（摘要链路）应 403，实际 ${blockedWrite.status}`);
      }
      const writeLog = await waitForLog(dataDir, (record) => record.message === '写操作被拦下：来源不在白名单内');
      if (!writeLog) bad.push('写操作被白名单拦下时缺少留痕（期望 reason 为 allowlist 的应用日志）');
    },
  );

  /* ② 关掉开关（INDEX_SRV_DIGEST_ALLOWLIST=false）：写操作退回「只看摘要」，
        但提升接口不受该开关影响 —— 它始终受白名单约束 */
  await withServer(
    {
      INDEX_SRV_SECRET: TEST_SECRET,
      INDEX_SRV_PERMISSION_ALLOWLIST: '10.99.0.0/16',
      INDEX_SRV_DIGEST_ALLOWLIST: 'false',
    },
    async ({ base }) => {
      const allowed = await write(base, '关掉开关后的写入');
      if (allowed.status !== 200) {
        bad.push(`关掉 digestAllowlistEnabled 后写操作应放行，实际 ${allowed.status}`);
      }
      const stillBlocked = await elevate(base);
      if (stillBlocked.status !== 403) {
        bad.push(`提升接口不受 digestAllowlistEnabled 影响，白名单外仍应 403，实际 ${stillBlocked.status}`);
      }
    },
  );

  /* ③ 白名单放行本机：提升与写操作都恢复正常 */
  await withServer(
    { INDEX_SRV_SECRET: TEST_SECRET, INDEX_SRV_PERMISSION_ALLOWLIST: '127.0.0.1/32' },
    async ({ base }) => {
      const elevated = await elevate(base);
      const body = await elevated.json().catch(() => ({}));
      if (elevated.status !== 200 || body.data?.level !== 0) {
        bad.push(`白名单内来源应能提升（200 / level 0），实际 ${elevated.status} / ${body.data?.level}`);
      }
      const allowed = await write(base, '白名单内的写入');
      if (allowed.status !== 200) {
        bad.push(`白名单内来源的写操作应放行（开关默认开启也只约束名单外的来源），实际 ${allowed.status}`);
      }
    },
  );

  /* ④ 配置文件写法（默认用法）：拷一份默认配置，把白名单写进 server 段 */
  const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'config', 'default.json'), 'utf8'));
  const configFile = path.join(os.tmpdir(), `index-srv-allowlist-${process.pid}.json`);
  fs.writeFileSync(
    configFile,
    `${JSON.stringify({ ...defaults, server: { ...defaults.server, permissionAllowlist: ['10.99.0.0/16'] } }, null, 2)}\n`,
  );
  try {
    await withServer({ INDEX_SRV_CONFIG: configFile, INDEX_SRV_SECRET: TEST_SECRET }, async ({ base }) => {
      const blocked = await elevate(base);
      if (blocked.status !== 403) {
        bad.push(`配置文件里的 permissionAllowlist 未生效：提升应 403，实际 ${blocked.status}`);
      }
    });
  } finally {
    fs.rmSync(configFile, { force: true });
  }

  /* ⑤ 默认配置必须放行回环：本机开发与上面的用例都依赖它
        （默认列表到底覆盖了哪些网段，由 check-static 用 net.js 的匹配函数实算把关） */
  if (!(defaults.server?.permissionAllowlist ?? []).includes('127.0.0.0/8')) {
    bad.push(
      `默认配置的 permissionAllowlist 应放行回环（127.0.0.0/8），实际 ${JSON.stringify(defaults.server?.permissionAllowlist)}`,
    );
  }
  if (defaults.server?.digestAllowlistEnabled !== true) {
    bad.push(
      `默认配置的 digestAllowlistEnabled 应为 true（摘要链路默认受白名单约束），实际 ${defaults.server?.digestAllowlistEnabled}`,
    );
  }
}

/* ---------------- 模式七：权限切换留痕（对端地址 + 转发头 + 级别迁移 + pass/block） ---------------- */

/**
 * 一次权限切换要能在日志里回答三个问题：谁在切（对端真实地址 + 请求携带的转发头）、
 * 切前切后的级别（3 user / 0 super）、结果（pass / block）与依据（reason）。
 */
async function checkPermissionLogging() {
  const digest = digestOf(TEST_SECRET);
  const elevate = (base, body, headers = {}) =>
    fetch(`${base}/api/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  /* ① 放行：记录对端地址与转发头，消息为「3 user -> 0 super pass」 */
  await withServer({ INDEX_SRV_SECRET: TEST_SECRET }, async ({ base, dataDir }) => {
    await elevate(base, { digest }, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'x-real-ip': '203.0.113.9' });
    const pass = await waitForLog(dataDir, (record) => record.message?.endsWith('0 super pass'));
    if (!pass) {
      bad.push('提升成功的日志缺失（期望「权限切换 3 user -> 0 super pass」）');
    } else {
      if (pass.message !== '权限切换 3 user -> 0 super pass') bad.push(`提升日志文案不符：${pass.message}`);
      if (pass.level !== 'info') bad.push(`放行应记 info 级别，实际 ${pass.level}`);
      if (pass.ip !== '127.0.0.1') bad.push(`提升日志应记录 TCP 对端地址，实际 ${pass.ip}`);
      if (pass.xForwardedFor !== '203.0.113.9, 10.0.0.1') {
        bad.push(`提升日志未原样记录 x-forwarded-for，实际 ${pass.xForwardedFor}`);
      }
      if (pass.xRealIp !== '203.0.113.9') bad.push(`提升日志未记录 x-real-ip，实际 ${pass.xRealIp}`);
      if (pass.reason !== 'digest') bad.push(`提升日志的 reason 应为 digest，实际 ${pass.reason}`);
    }

    /* ② 摘要错误：同样留痕，但结果是 block（warn 级别） */
    await elevate(base, { digest: digestOf('wrong-secret') });
    const blocked = await waitForLog(
      dataDir,
      (record) => record.reason === 'digest-mismatch',
    );
    if (!blocked) {
      bad.push('摘要错误的拦下日志缺失（期望 reason 为 digest-mismatch 的记录）');
    } else {
      if (blocked.message !== '权限切换 3 user -> 0 super block') bad.push(`拦下日志文案不符：${blocked.message}`);
      if (blocked.level !== 'warn') bad.push(`拦下应记 warn 级别，实际 ${blocked.level}`);
      if ('xForwardedFor' in blocked) bad.push('请求没带转发头时不应凭空写出 xForwardedFor 字段');
    }
  });

  /* ③ 白名单拦截：reason 为 allowlist 的 block 记录 */
  await withServer(
    { INDEX_SRV_SECRET: TEST_SECRET, INDEX_SRV_PERMISSION_ALLOWLIST: '10.99.0.0/16' },
    async ({ base, dataDir }) => {
      await elevate(base, { digest });
      const blocked = await waitForLog(dataDir, (record) => record.reason === 'allowlist');
      if (!blocked) bad.push('白名单拦截的日志缺失（期望 reason 为 allowlist 的记录）');
      else if (blocked.message !== '权限切换 3 user -> 0 super block') {
        bad.push(`白名单拦截日志文案不符：${blocked.message}`);
      }
    },
  );

  /* ④ 未配置密钥时的拦截也要留痕：reason 为 unconfigured */
  await withServer({ INDEX_SRV_SECRET: '' }, async ({ base, dataDir }) => {
    await elevate(base, { digest });
    const blocked = await waitForLog(dataDir, (record) => record.reason === 'unconfigured');
    if (!blocked) bad.push('未配置密钥时的拦下日志缺失（期望 reason 为 unconfigured 的记录）');
  });
}

/* ---------------- 模式八：可信网段免密钥（server.trustedNetworkBypass） ---------------- */

/**
 * 浏览器在**非安全上下文**（`http://内网IP`）下没有 Web Crypto，算不出摘要，
 * 客户端会直接拒绝提权（连请求都不发）。这条通道把「白名单网段」本身当作凭据：
 * 开启后白名单内来源免摘要即 super，提权与写入都放行。
 */
async function checkTrustedNetworkBypass() {
  const digest = digestOf(TEST_SECRET);
  const getPermission = async (base, headers = {}) =>
    (await (await fetch(`${base}/api/permission`, { headers })).json()).data;
  const putConfig = (base, title, headers = {}) =>
    fetch(`${base}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ title }),
    });
  const elevate = (base, headers = {}) =>
    fetch(`${base}/api/permission`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

  /* ① 开关关闭（默认）：白名单内也必须提交摘要 —— 凭据仍是密钥 */
  await withServer({ INDEX_SRV_SECRET: TEST_SECRET }, async ({ base }) => {
    const permission = await getPermission(base, { 'x-service-digest': digest });
    if (permission.level !== 0 || permission.reason !== 'digest') {
      bad.push(`开关关闭时应靠摘要提升为 super/digest，实际 ${JSON.stringify(permission)}`);
    }
    const write = await putConfig(base, '默认下不带摘要的写入');
    if (write.status !== 401) bad.push(`开关关闭时不带摘要的写操作应 401，实际 ${write.status}`);
  });

  /* ② 开关打开：白名单内免摘要即 super（提权与写入都放行），且启动与切换都留痕 */
  await withServer(
    { INDEX_SRV_SECRET: TEST_SECRET, INDEX_SRV_TRUSTED_BYPASS: 'true' },
    async ({ base, dataDir }) => {
      const permission = await getPermission(base);
      if (permission.level !== 0 || permission.reason !== 'trusted-network') {
        bad.push(`可信网段内应免密钥下发 super/trusted-network，实际 ${JSON.stringify(permission)}`);
      }
      const elevated = await elevate(base);
      const body = await elevated.json().catch(() => ({}));
      if (elevated.status !== 200 || body.data?.reason !== 'trusted-network') {
        bad.push(`可信网段内的提升应 200 / trusted-network，实际 ${elevated.status} / ${body.data?.reason}`);
      }
      const write = await putConfig(base, '可信网段免密钥写入');
      if (write.status !== 200) {
        bad.push(`可信网段内不带任何凭据的写操作应 200，实际 ${write.status}`);
      }
      const switchLog = await waitForLog(
        dataDir,
        (record) => record.reason === 'trusted-network' && record.result === 'pass',
      );
      if (!switchLog) bad.push('可信网段免密钥的权限切换没有留痕（期望 reason 为 trusted-network 的记录）');
      const bootLog = await waitForLog(
        dataDir,
        (record) => record.message === '可信网段免密钥已启用：白名单内的来源无需服务密钥即可提权与写入',
      );
      if (!bootLog) bad.push('启动时未提示可信网段免密钥已启用（该模式必须可见）');
    },
  );

  /* ③ 开关打开但来源不在白名单：仍然 403 —— 网段本身就是凭据 */
  await withServer(
    {
      INDEX_SRV_SECRET: TEST_SECRET,
      INDEX_SRV_TRUSTED_BYPASS: 'true',
      INDEX_SRV_PERMISSION_ALLOWLIST: '10.99.0.0/16',
    },
    async ({ base }) => {
      const blockedElevate = await elevate(base);
      if (blockedElevate.status !== 403) {
        bad.push(`可信网段之外即便打开开关也应 403（提升），实际 ${blockedElevate.status}`);
      }
      const blockedWrite = await putConfig(base, '名单外写入');
      if (blockedWrite.status !== 403) {
        bad.push(`可信网段之外的写操作应 403，实际 ${blockedWrite.status}`);
      }
    },
  );

  /* ④ 安全前提：未配置密钥时，来源再可信也仍然只读 */
  await withServer({ INDEX_SRV_SECRET: '', INDEX_SRV_TRUSTED_BYPASS: 'true' }, async ({ base }) => {
    const permission = await getPermission(base);
    if (permission.level !== 3 || permission.reason !== 'unconfigured') {
      bad.push(`未配置密钥时应保持只读（3 / unconfigured），实际 ${JSON.stringify(permission)}`);
    }
    const write = await putConfig(base, '无密钥时的写入');
    if (write.status !== 401) bad.push(`未配置密钥时不计凭据的写操作也应 401（只读优先），实际 ${write.status}`);
  });
}

/* ---------------- 模式九：反代后的客户端地址（X-Forwarded-For 只在可信代理后采信） ---------------- */

/**
 * 前置 nginx 后：socket 对端恒为代理，白名单必须靠 XFF；但无条件采信 XFF 等于把
 * 白名单交给伪造者。判定标准用的是「提升接口的 403（白名单拦下）vs 401（放行但摘要不对）」，
 * 这样能精确看出服务端最终采信的是哪个地址。
 */
async function checkTrustedProxies() {
  const digest = digestOf('wrong-secret'); // 摘要故意不对：通过白名单后必然 401
  const elevate = (base, xff) =>
    fetch(`${base}/api/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(xff ? { 'x-forwarded-for': xff } : {}) },
      body: JSON.stringify({ digest }),
    });
  const allowOnlyVpn = { INDEX_SRV_PERMISSION_ALLOWLIST: '10.99.0.0/16' };

  /* ① 未配置可信代理：伪造 XFF 无效，白名单仍按 socket 地址（127.0.0.1）拦下 */
  await withServer({ INDEX_SRV_SECRET: TEST_SECRET, ...allowOnlyVpn }, async ({ base }) => {
    const status = (await elevate(base, '10.99.0.5')).status;
    if (status !== 403) bad.push(`未配置可信代理时伪造 XFF 不应生效（期望 403），实际 ${status}`);
  });

  /* ② 对端是可信代理：采信 XFF 里的真实客户端（落在放行网段内 → 401 而非 403） */
  await withServer(
    { INDEX_SRV_SECRET: TEST_SECRET, ...allowOnlyVpn, INDEX_SRV_TRUSTED_PROXIES: '127.0.0.1/32' },
    async ({ base, dataDir }) => {
      const status = (await elevate(base, '10.99.0.5')).status;
      if (status !== 401) bad.push(`可信代理后应按 XFF 识别客户端（期望 401），实际 ${status}`);

      // 客户端伪造前置项：取右端（代理亲眼看到的那个）才是真值
      const spoofed = (await elevate(base, '203.0.113.9, 10.99.0.5')).status;
      if (spoofed !== 401) bad.push(`应取 XFF 右端地址（期望 401），实际 ${spoofed}`);

      // 回归（实测发现过）：最右项本身是可信代理（如 Docker 把宿主机来源改写成网桥网关）
      // 时不得继续往左找 —— 那一段是客户端可控的，会变成「伪造即通过白名单」
      const gateway = (await elevate(base, '10.99.0.5, 127.0.0.1')).status;
      if (gateway !== 403) bad.push(`最右项是可信代理时不得采信左侧伪造值（期望 403），实际 ${gateway}`);

      // 反向确认：右端是公网地址时仍应被白名单拦下（说明确实在用 XFF，而非放行一切）
      const outside = (await elevate(base, '203.0.113.9')).status;
      if (outside !== 403) bad.push(`可信代理但客户端在放行网段外应 403，实际 ${outside}`);

      // 留痕里也应是对端真实地址（不是 nginx 容器地址）
      const record = await waitForLog(dataDir, (r) => r.reason === 'digest-mismatch');
      if (!record) bad.push('按 XFF 识别客户端后缺少拦下留痕');
      else if (record.ip !== '10.99.0.5') bad.push(`留痕里的 ip 应为解析后的客户端地址，实际 ${record.ip}`);
    },
  );
}

async function main() {
  await checkReadOnlyMode();
  await checkSecretMode();
  await checkPermissionAllowlist();
  await checkPermissionLogging();
  await checkTrustedNetworkBypass();
  await checkTrustedProxies();
  await checkLegacyMigration();
  await checkServiceSchema();
  await checkIntro();

  if (bad.length) {
    console.error(`✘ ${bad.length} 项问题:\n - ${bad.join('\n - ')}`);
    process.exit(1);
  }
  console.log(
    '✔ 端到端冒烟通过（页面 + 全部静态资源 + 只读模式 + 密钥鉴权 + 权限提升白名单 + 权限切换留痕 + 可信网段免密钥 + 反代客户端地址 + 数据往返 + 分区写回 + 旧文件迁移 + 草稿骨架可配置 + 说明文档两种形态 + 新建命名空间 + 编辑服务 + 自定义字段 + 无删除接口 + 穿越防护 + 协商缓存）',
  );
}

main().catch((error) => {
  console.error(`✘ 冒烟测试异常：${error.message}`);
  process.exit(1);
});
