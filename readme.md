# index srv

轻量级服务索引面板：用一个页面收纳散落在云服务器上的各种服务（面板、网关、存储、工具），支持多主题与灵活配置。

后端是 **零依赖的 Node.js HTTP 服务**（仅使用 Node 内置模块），前端是 **纯原生 HTML / CSS / JavaScript**（无框架、无构建步骤）。整个项目的运行依赖只有 Node.js 本身。

## Feature

- 极其轻量：后端零 npm 依赖，前端无框架无打包，镜像基于 `node:lts-alpine3.23`（Node 24 LTS）
- 纯原生：ES Module + CSS 自定义属性 + `<template>`，浏览器直接加载源码
- 多主题：亮/暗/跟随系统三态切换，7 种强调色，偏好持久化到本地
- 配置灵活：单文件 JSON 数据源 + 完整的 REST API，支持命名空间、标签、状态、排序、启用/下线、整份导入导出
- 结构清晰：左侧命名空间目录树 + 右侧 `key: value` 属性详情，服务状态以红/绿/蓝/黄四色标注
- 类型化展示：属性值按类型选组件 —— 基本类型文本、数组分块、对象以 JSON 代码块展示，`status` 为色调块、`url` 为可点击链接
- 权限可控：页头显示权限级别（0 super / 3 user）；配置 `INDEX_SRV_SECRET` 后点击组件输入密钥即可提升，浏览器端先把密钥算成 SHA-256 摘要再提交，服务端也只保留摘要
- 首屏轻快：设置、权限、目录、服务、统计合并为单次请求，无框架、无字体、无外部 CDN
- 默认风格对齐 shadcn/ui：直角、无动效，结构与样式彻底分离
- 图标规范：图标统一取自 lucide，开发期生成约 4 KB 的 sprite，运行时不加载任何图标库
- 部署简单：支持本地开发直跑与 Docker Compose 两种方式

## 架构与目录

核心约定：**`src/` 放代码与 srv 配置，`data/` 放运行期数据**，二者不混用 —— 因此容器部署时只需挂载 `data/` 一个目录即可完成持久化。

完整的目录结构、架构图（Mermaid）与技术交互细节见 [docs/arch.md](docs/arch.md)。

## 快速开始

前置要求：Node.js ≥ 20（推荐 20/22/24），或 Docker + Docker Compose v2。

### 方式一：本地开发（Node 直跑）

适合本机开发与调试，无需任何安装步骤。

```bash
cd index_srv
npm start                          # 等价于 node src/server.js
# 打开 http://127.0.0.1:8080
```

开发模式（服务端改动自动重启）：

```bash
npm run dev
```

常用覆盖：

```bash
INDEX_SRV_PORT=9000 INDEX_SRV_HOST=0.0.0.0 INDEX_SRV_LOG_LEVEL=debug npm start
```

> **未配置 `INDEX_SRV_SECRET` 时面板只读**：可以正常浏览，但无法写入（权限固定为 3 user）。需要写入时用 `INDEX_SRV_SECRET=你的密钥 npm start`，之后点击页头权限组件输入同一个密钥即可提升为 super。

> 图标精灵 `src/web/icons/sprite.svg` 与 vendored 的 `src/web/vendor/codejar.js` 都已随仓库提交，**运行与部署都不需要 `npm install`**；只有增改图标（`npm install && npm run icons`）或升级 CodeJar（`npm install && npm run vendor`）时才需要它。参见 [docs/ui.md](docs/ui.md#8-扩展指南)。

### 方式二：Docker Compose 部署

适合与其它服务共存于同一台宿主机，隔离依赖并统一管理。

```bash
cd index_srv

# 1. 准备环境变量
cp .env.example .env
vi .env                             # 按需修改端口、监听地址、令牌

# 2. 构建并启动
docker compose up -d --build

# 3. 查看状态与日志
docker compose ps
docker compose logs -f index-srv

# 4. 健康检查（容器内置 HEALTHCHECK，也可手动验证）
curl -s http://127.0.0.1:8080/api/health
```

`.env` 中的关键变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `INDEX_SRV_PORT` | `8080` | 宿主机映射端口（容器内固定 8080） |
| `INDEX_SRV_BIND` | `127.0.0.1` | 宿主机监听地址，对外暴露改为 `0.0.0.0` |
| `INDEX_SRV_SECRET` | 空 | 服务密钥，非空时写操作需携带其摘要；留空则面板只读 |
| `INDEX_SRV_LOG_LEVEL` | `info` | 日志级别 |
| `INDEX_SRV_TAG` | `latest` | 镜像标签 |
| `TZ` | `Asia/Shanghai` | 容器时区，影响日志时间与文件按天切分 |

常用运维命令：

```bash
docker compose restart index-srv            # 重启（手工改过数据文件后必须重启）
docker compose down                         # 停止并移除容器（data/ 数据保留在宿主机）
docker compose up -d --build                # 更新代码后重建
docker compose exec index-srv ls -l data    # 查看数据目录
```

数据持久化：`docker-compose.yml` 已将 `./data` 挂载到容器 `/app/data`，配置与日志都落在宿主机 `./data` 下，删除容器不会丢失数据。

> 权限提示：容器以 `node` 用户（uid 1000）运行。若宿主机 `data/` 属主不是 uid 1000，会出现写入失败，任选其一：
> ```bash
> sudo chown -R 1000:1000 data          # 方案 A：调整宿主机目录属主
> ```
> 或在 `docker-compose.yml` 中取消 `user: "1000:1000"` 的注释并填入实际 `uid:gid`（方案 B）。

需要写入数据时，在 `.env` 里配置服务密钥并重启（**未配置则接口只读**）：

```bash
# 密钥只在服务启动时读取一次，此后内存中只保留它的 SHA-256 摘要
echo "INDEX_SRV_SECRET=$(openssl rand -hex 24)" >> .env
docker compose restart index-srv
```

写操作需带密钥的 SHA-256 摘要（界面上的权限组件做的是同一件事）：

```bash
# 注意用 printf 而不是 echo：多一个换行符就会算出不同的摘要
DIGEST=$(printf '%s' "$SECRET" | sha256sum | cut -d' ' -f1)
curl -X PUT http://127.0.0.1:8080/api/config \
  -H 'content-type: application/json' \
  -H "x-service-digest: $DIGEST" \
  -d '{"theme":"dark"}'
```

容器默认只把端口发布到宿主机 `127.0.0.1:8080`，由反向代理（Nginx / Caddy）对外提供服务：

```nginx
# /etc/nginx/conf.d/index-srv.conf
server {
    listen 443 ssl;
    server_name nav.example.com;

    ssl_certificate     /etc/letsencrypt/live/nav.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/nav.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 配置说明

服务端配置的唯一来源是 `src/config/default.json`，所有字段都可以被环境变量覆盖（便于容器化部署）。

### `src/config/default.json`

```jsonc
{
  "name": "index-srv",
  "version": "0.1.0",
  "server": {
    "host": "0.0.0.0",            // 监听地址
    "port": 8080,                 // 监听端口
    "requestLimitBytes": 262144,  // 请求体上限（256 KiB）
    "cors": {
      "enabled": false,           // 是否允许跨域
      "origins": []               // 允许的来源，空数组表示不限制
    }
  },
  "storage": {
    "dataDir": "data",                 // 数据根目录（相对项目根）
    "confDir": "conf",                 // 配置类分区目录（相对 dataDir）
    "sectionDir": "section",           // 数据源分区目录（相对 dataDir）
    "logDir": "log",                   // 日志目录（相对 dataDir）
    "legacyConfFile": "conf/sites.json", // 旧版单文件，仅作迁移来源
    "serviceSchemaFile": "conf/service.schema.json" // 新建服务的草稿骨架（启动时读入）
  },
  "web": {
    "dir": "src/web",             // 前端资源目录
    "index": "index.html",        // 默认文档
    "cacheMaxAge": 0              // 静态资源强缓存秒数，0 表示 no-cache + ETag
  },
  "log": {
    "level": "info",              // debug / info / warn / error
    "toStdout": true,
    "toFile": true
  }
}
```

### 环境变量

优先级高于配置文件，命名统一为 `INDEX_SRV_*`（含服务密钥；它按约定不进配置文件，只从环境变量读取）：

| 变量 | 对应配置 | 说明 |
| --- | --- | --- |
| `INDEX_SRV_CONFIG` | - | 指定另一份配置文件路径 |
| `INDEX_SRV_ROOT` | - | 项目根目录，容器内为 `/app` |
| `INDEX_SRV_HOST` | `server.host` | 监听地址 |
| `INDEX_SRV_PORT` | `server.port` | 监听端口 |
| `INDEX_SRV_REQUEST_LIMIT` | `server.requestLimitBytes` | 请求体上限（字节） |
| `INDEX_SRV_CORS_ORIGINS` | `server.cors` | 逗号分隔的来源列表，设置后自动开启 CORS |
| `INDEX_SRV_DATA_DIR` | `storage.dataDir` | 数据根目录 |
| `INDEX_SRV_LOG_DIR` | `storage.logDir` | 日志目录（相对 dataDir，也可给绝对路径） |
| `INDEX_SRV_WEB_DIR` | `web.dir` | 前端资源目录 |
| `INDEX_SRV_WEB_CACHE` | `web.cacheMaxAge` | 静态资源缓存秒数 |
| `INDEX_SRV_SECRET` | - | 服务密钥，**只从环境变量读取**（不落配置文件）；留空则接口只读 |
| `INDEX_SRV_LOG_LEVEL` | `log.level` | 日志级别 |

> **升级提示**：服务密钥的环境变量名早期是 `INDEX_SERVICE_SECRET`，现已统一为 `INDEX_SRV_SECRET`，与其余变量同前缀。升级时同步改名即可 —— 漏改**不会**意外放行写操作，只会因为它「未配置」而退回只读（启动日志会写明当前识别到的密钥状态）。

## 数据管理

面板内容按语义分成三份文件，结构见 [docs/api.md](docs/api.md#8-附数据文件结构)：

| 文件 | 内容 |
| --- | --- |
| `data/conf/settings.json` | 面板标题、默认主题与显示开关（配置类） |
| `data/section/namespace.json` | 命名空间 |
| `data/section/service.json` | 服务（含状态与自由属性） |

- **改内容三条路**：① 页面内直接改（需提升为 super：目录行尾 `[+]` 新建服务、详情面板 `[pencil]` 编辑服务 JSON、侧栏头部 `[+]` 新建命名空间）；② 直接编辑 JSON 文件（改完需重启服务）；③ 调用 API（无需重启）。三种方式都只回写内容确实变化的那一份文件。
- **扩展新建服务的草稿**：编辑 `data/conf/service.schema.json`（配置类文件，不参与上面三份分区的写回）—— 加一个字段，点 `[+]` 新建服务时草稿里就多一个占位（如 `"owner": ""`），改完需重启服务。缺失或内容不是 JSON 对象时回落到内置骨架，启动日志与 `GET /api/config` 的 `runtime.serviceSchemaSource` 会说明来源（`file` / `default` / `invalid`）。归属命名空间由客户端注入，模板里写了 `namespaceId` 也会被忽略。
- **备份**：`cp -r data data.bak`，或 `curl -s http://127.0.0.1:8080/api/store -o backup.json`（整份导出为单个 JSON）。
- **恢复**：把 `data.bak` 覆盖回 `data/` 后重启，或 `curl -X PUT .../api/store --data-binary @backup.json` 整份导入。
- **从旧版本升级**：老版本的单文件 `data/conf/sites.json` 无需手工拆分 —— 启动时若发现分区文件缺失会自动拆分落盘（旧文件保留不动，确认无误后可自行删除）。
- **演示数据**：种子数据里有一条 `值渲染样例`（`s-render-demo`，在「工具」命名空间下），它的属性刻意覆盖了全部展示形态 —— 常规文本、数字/布尔等宽、空值占位、chunk 分块、JSON 代码块，且刻意留空描述与空标签，用来一次性查看所有值类型在界面上的效果。不需要时删掉这条服务即可。
- **日志**：`data/log/app-YYYY-MM-DD.log`（服务日志）与 `data/log/access-YYYY-MM-DD.log`（访问日志，含方法、路径、状态码、耗时），均为 JSON Lines 格式，按天切分。查看实时访问情况：

```bash
tail -f data/log/access-$(date +%F).log | grep -o '"status":[0-9]*'
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/arch.md](docs/arch.md) | 架构说明：目录结构、架构图（Mermaid）、请求链路、技术搭建与交互细节 |
| [docs/api.md](docs/api.md) | API 接入规范：统一响应体、鉴权、错误码、全部接口的请求/响应示例 |
| [docs/ui.md](docs/ui.md) | Web UI：目录结构、CSS 分层与令牌、主题机制、渲染流程、扩展指南与约束清单 |

## 测试

回归套件是零依赖的 Node 脚本（不引入测试框架），一条命令跑完五项：

```bash
npm test
```

| 检查 | 单独运行 | 拦得住什么 |
| --- | --- | --- |
| 静态契约 | `node tests/check-static.mjs` | 内联样式/事件；引用了不存在的 id、类或令牌；定义了却无人引用的令牌；圆角与动效约束被破坏；布局不变量被改掉；模块依赖分层被打破、出现循环依赖或死导出；图标清单与 sprite 不一致 |
| 纯逻辑 | `node tests/check-logic.mjs` | 主题状态机与偏好优先级、DOM 工具、模板基元、API 客户端的解包与失败分支 |
| 渲染快照 | `node tests/check-render.mjs` | 目录树与详情的结构、类名、文案、条件分支，与基线逐字节比对 |
| 文档一致性 | `node tests/check-docs.mjs` | 文档链接与锚点失效、标题层级、mermaid 结构、文档对代码的引用是否已过期 |
| 端到端冒烟 | `node tests/check-server.mjs` | 服务能否启动、前端资源是否都投放得到、接口与数据是否一致、路径穿越防护与协商缓存 |

界面回归靠「渲染快照对比」：套件自带一个极简 DOM 垫片，在 Node 里运行 `render.js` / `detail.js` / `alert.js`，把渲染结果序列化后与 `tests/fixtures/render.expected.json` 逐字节比对。**有意**改变界面时执行：

```bash
npm run test:update      # 刷新渲染基线，提交前请审阅 diff
```

> **当前环境无法直接做视觉验证**（无任何可用浏览器内核），因此界面验证降级为「**多方面 DOM 校验 + 人工验收**」：上面五项检查覆盖结构、类名、文案、条件分支、接口与资源投放；真实渲染、布局排版、配色观感与响应式表现需人工在浏览器中确认。降级原因、覆盖边界与恢复自动化的方式见 [docs/arch.md](docs/arch.md#9-回归套件) §9.1。

## 开发约定

1. **运行期不引入 npm 包**：后端只用 Node 内置模块，前端只用浏览器原生能力。确需引入运行期依赖时必须先与作者确认；开发期工具类依赖（当前为 `lucide-static` 生成图标精灵、`codejar` 供 vendoring）登记为 `devDependencies`，产物（`src/web/icons/sprite.svg` 与 `src/web/vendor/` 下的源码）提交到仓库，从而保证部署与容器构建都无需 `npm install`。
2. `src/` 放代码与配置，`data/` 放运行期数据，二者不混用。
3. 前端保持 HTML / CSS / JS 分离：HTML 中不出现样式与内联事件，CSS 中不出现动效与圆角。
4. 新增接口在 `src/api/` 下建模块，并在 `src/api/index.js` 注册；同时更新 `docs/api.md`。
5. 新增 UI 组件或令牌时同步更新 `docs/ui.md`，并核对其"约束清单"。
6. 目录结构、模块职责或数据流发生变化时，同步更新 `docs/arch.md`。
7. 改动后执行 `npm test`；若界面变化是本次改动的预期结果，用 `npm run test:update` 刷新渲染基线并审阅 diff 后再提交。

## 常见问题

**页面打不开 / 端口被占用**

```bash
ss -ltnp | grep 8080            # 查看占用
INDEX_SRV_PORT=9000 npm start   # 换端口
```

**界面显示"加载失败"**

检查服务是否正常（`curl http://127.0.0.1:8080/api/health`），并查看 `data/log/app-$(date +%F).log`，日志为逐行 JSON，可直接读取 `message` 字段。

**修改了数据文件但页面没变化**

服务启动后数据常驻内存，手工编辑需重启服务；如需免重启请使用 API。

**写操作返回 401**

两种可能：

1. 服务端**没有**配置 `INDEX_SRV_SECRET`：此时接口只读，任何写操作都会返回 401。配置密钥并重启即可。
2. 已配置密钥：请求需带密钥的 SHA-256 摘要（`x-service-digest: <64 位小写十六进制>` 或 `Authorization: Bearer <摘要>`）。注意摘要必须由**原始密钥**算出且不含多余换行：`printf '%s' "$SECRET" | sha256sum | cut -d' ' -f1`。

**容器启动后 API 报权限错误**

`data/` 属主与容器内 `node` 用户（uid 1000）不一致，见上文 Docker 部署的权限提示。

**Docker 部署时前端样式/脚本没更新**

静态资源默认 `no-cache` + ETag，正常会即时生效；若中间有 CDN 或代理缓存，可强制刷新或调整 `INDEX_SRV_WEB_CACHE`。

## License

Private / personal use.
