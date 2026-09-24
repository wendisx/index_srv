# index-srv API 规范

面向外部调用的 HTTP 接口约定。服务端实现见 `src/server.js`、`src/core/router.js` 与 `src/api/`；整体架构与请求链路见 [arch.md](arch.md)。

- 基础路径：`/api`
- 请求与响应编码：`UTF-8`
- 请求体格式：`application/json`
- 版本：`v0.1.0`（接口路径中暂不含版本号，破坏性变更会提升 `package.json` 主版本并在此文档标注）

> **v0.1.0 破坏性变更**：`groups` 已重命名为 `namespaces`，服务归属字段 `groupId` → `namespaceId`，接口 `/api/groups*` → `/api/namespaces*`。
> 旧数据文件（v1）在服务启动时会自动迁移并回写，但**旧接口路径不再提供**。迁移细节见 [§8](#8-附数据文件结构)。

---

## 1. 统一响应体

所有 `/api` 接口返回同构 JSON，便于客户端统一处理。

成功（HTTP 2xx）：

```json
{
  "ok": true,
  "data": {}
}
```

失败（HTTP 4xx / 5xx）：

```json
{
  "ok": false,
  "error": {
    "code": "validation_error",
    "message": "status 只能是 running / stopped / coming / developing",
    "details": { "field": "status" }
  }
}
```

- `data` 的结构由具体接口决定，见下文各接口说明。
- `error.details` 为可选字段，校验类错误会携带 `field`（必要时还有 `key`）。
- 系统**不提供任何删除接口**：对 `/api/sites/:id`、`/api/namespaces/:id` 发起 `DELETE` 会得到 `405`（响应带 `allow` 头列出可用方法），数据不会被改动。

### 状态码与错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `bad_request` | 请求体不是合法 JSON、请求体非对象、路径非法 |
| 401 | `unauthorized` | 写操作缺少/错误摘要，或服务端未配置密钥时尝试写入；提升权限时摘要不正确 |
| 403 | `forbidden` | 路径越权访问 |
| 404 | `not_found` | 接口或资源不存在 |
| 405 | `method_not_allowed` | 方法不被支持，响应头 `Allow` 会列出可用方法 |
| 409 | `conflict` | 资源冲突，如 id 重复、命名空间下仍有服务 |
| 413 | `payload_too_large` | 请求体超过 `server.requestLimitBytes`（默认 256 KiB） |
| 422 | `validation_error` | 字段校验失败，`details.field` 指出问题字段 |
| 500 | `internal_error` | 服务内部错误，详见 `data/log/app-*.log` |

---

## 2. 鉴权与权限级别

### 权限级别

客户端（Web UI 页头方框）显示的权限级别由服务端下发，取值：

| level | role | 含义 |
| --- | --- | --- |
| `0` | `super` | 可执行写操作 |
| `3` | `user` | 只读（默认） |

判定规则（`src/api/permission.js`）：

| 场景 | level | secretRequired | reason |
| --- | --- | --- | --- |
| 服务端未配置 `INDEX_SRV_SECRET` | `3` | `false` | `unconfigured` |
| 已配置密钥，且请求携带正确摘要 | `0` | `true` | `digest` |
| 已配置密钥，请求未携带或摘要错误 | `3` | `true` | `anonymous` |

> 未配置密钥时**不存在** super：接口整体只读，任何写操作都会返回 `401`。

### 权限提升的来源白名单

`server.permissionAllowlist`（IP 或 CIDR 列表，可用环境变量 `INDEX_SRV_PERMISSION_ALLOWLIST` 覆盖）用于限制**提升动作**的来源。默认放行回环与 RFC 1918 内网段：

```json
"permissionAllowlist": ["127.0.0.0/8", "::1", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
```

| 取值 | 行为 |
| --- | --- |
| 上面这份内网列表（默认） | 回环与内网来源可提升，公网来源返回 `403 forbidden` |
| `["192.168.1.0/24", "10.0.0.5"]` | 自定义：只有命中任一规则的来源能提升 |
| `[]` | **不限制** —— 任何来源都能调 `POST /api/permission`（谨慎：等于把安全责任全交给密钥） |

- 判定用的是 **TCP 连接的对端地址**，不信任 `X-Forwarded-For`（该头可被客户端伪造，除非前面有可信代理）；IPv4-mapped 地址（`::ffff:1.2.3.4`）会归一化成 IPv4 再比较；
- IPv6 **只支持完整地址精确匹配**（如上面的 `::1`），IPv6 网段（`fd00::/8`、`fe80::/10`）不参与匹配；
- 判定**先于**密钥校验：非白名单来源连摘要比对都不会进入，也拿不到任何关于密钥是否正确的信息；
- 它只拦「提升」：`GET /api/permission` 与**写操作**仍以摘要为准 —— 这是提升入口的网段限制，不是授权机制，密钥本身仍应只发给可信网络。

### 服务密钥与摘要

密钥只从环境变量 `INDEX_SRV_SECRET` 读取，且只在**服务启动时读一次**，随即转成 SHA-256 摘要 ——
内存与接口响应里都不出现明文。客户端提交的同样是摘要，两侧用定长比较。

因此用 curl 调写接口前需要自己先算一次摘要：

```bash
# 注意用 printf 而不是 echo：多一个换行符就会算出完全不同的摘要
SECRET='你的密钥'
DIGEST=$(printf '%s' "$SECRET" | sha256sum | cut -d' ' -f1)
```

浏览器端由 Web UI 用 Web Crypto 计算同一个值（`src/web/js/digest.js`），两侧结果一致；
摘要格式固定为 **64 位小写十六进制**，格式不符时提升接口直接返回 `422`，不必等到比较。

### 写操作鉴权

- **未配置密钥**：无法取得 super，所有写操作返回 `401`。
- **已配置密钥**：**仅写操作**（`POST` / `PUT` / `PATCH`）需要携带摘要，`GET` 只读接口始终公开。

支持的两种传递方式（二选一）：

```http
x-service-digest: <64 位小写十六进制摘要>
```

```http
Authorization: Bearer <64 位小写十六进制摘要>
```

密钥生成方式：

```bash
openssl rand -hex 24
# docker 部署写入 .env 的 INDEX_SRV_SECRET 后重启容器
```

校验失败返回：

```json
{ "ok": false, "error": { "code": "unauthorized", "message": "写操作需要有效的服务密钥摘要（x-service-digest）" } }
```

> 摘要本身即凭据（等价于口令的哈希），请与服务密钥同等保护，只在内网或 HTTPS 下传输。
> 只读接口公开是刻意设计（面板需要免登录浏览）。若需公网暴露，请配合反向代理做 IP 白名单或 Basic Auth，`GET /api/store` 会返回含未启用服务在内的完整数据。

---

## 3. CORS

默认关闭。配置 `server.cors.enabled` 为 `true`，或通过 `INDEX_SRV_CORS_ORIGINS` 指定来源后开启：

```bash
# 逗号分隔；使用 * 放行全部来源
INDEX_SRV_CORS_ORIGINS=https://nav.example.com,http://localhost:5173
```

开启后会响应 `OPTIONS` 预检，并放行请求头 `content-type, authorization, x-service-digest, x-requested-with`。

---

## 4. 通用数据约定

| 字段 | 说明 |
| --- | --- |
| `id` | 命名空间与服务的唯一标识。创建时可省略，服务端生成 `ns-xxxxxxxx` / `s-xxxxxxxx` |
| `order` | 升序排序字段，数值越小越靠前；省略时自动追加到所在命名空间末尾 |
| `status` | 服务状态，枚举见 [§6.6](#66-服务接口)，手工标注，默认 `running` |
| `attributes` | 服务的自由键值对（任意 `key: value`）；值支持 JSON 原语（字符串 / 数字 / 布尔 / `null`）与嵌套的数组、对象，前端按值类型选择展示形式 |
| `namespaceId` | 服务归属的命名空间 id（v2 起，替代 v1 的 `groupId`） |
| `updatedAt` | ISO 8601 时间戳：分区文件各自维护，接口里的聚合值取各分区最新（按分区写回，见下） |

数据按语义分区落盘（可通过 `storage.confDir` / `storage.sectionDir` 调整目录）：

| 分区 | 文件 | 内容 |
| --- | --- | --- |
| 配置类 | `data/conf/settings.json` | 面板标题、默认主题、显示开关 |
| 数据源 | `data/section/namespace.json` | 命名空间列表 |
| 数据源 | `data/section/service.json` | 服务列表（状态与自由属性） |

写入采用「临时文件 + rename」保证原子性，同一进程内的写操作串行执行；一次写操作**只回写内容确实变化的那一份文件**（未变化的分区不写文件、也不刷新自己的 `updatedAt`）。接口层看到的 `settings` / `namespaces` / `sites` 是这三份文件的汇总视图。

> **删除数据**：面板与接口都不提供删除能力（见 [§1](#1-统一响应体) 的状态码说明）。需要移除命名空间或服务时，直接编辑上面三份 JSON 文件再重启服务；`PUT /api/store`（整份导入）也可用于覆盖式恢复，但它属于备份恢复通道，不是删除接口。

---

## 5. 接口一览

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/health` | - | 健康检查 |
| GET | `/api/permission` | - | 查询当前权限级别 |
| POST | `/api/permission` | - | 用密钥摘要提升权限 |
| GET | `/api/config` | - | 读取面板设置与运行信息 |
| PUT | `/api/config` | 是 | 更新面板设置（局部更新） |
| GET | `/api/nav` | - | 首屏聚合数据（设置 + 权限 + 命名空间 + 服务 + 统计） |
| GET | `/api/namespaces` | - | 命名空间列表（含服务数） |
| POST | `/api/namespaces` | 是 | 新建命名空间 |
| GET | `/api/namespaces/:id` | - | 命名空间详情 |
| PUT / PATCH | `/api/namespaces/:id` | 是 | 更新命名空间 |
| PUT | `/api/namespaces/order` | 是 | 批量设置命名空间顺序 |
| GET | `/api/sites` | - | 服务列表（支持过滤） |
| POST | `/api/sites` | 是 | 新建服务 |
| GET | `/api/sites/:id` | - | 服务详情 |
| PUT / PATCH | `/api/sites/:id` | 是 | 更新服务 |
| PUT | `/api/sites/order` | 是 | 批量设置服务顺序 |
| GET | `/api/store` | - | 导出完整数据 |
| PUT | `/api/store` | 是 | 覆盖式导入完整数据 |

---

## 6. 接口详情

### 6.1 GET /api/health

健康检查，可直接用于负载均衡或容器探针。

```json
{
  "ok": true,
  "data": {
    "status": "ok",
    "name": "index-srv",
    "version": "0.1.0",
    "uptimeSeconds": 128,
    "startedAt": "2026-09-22T08:48:31.134Z",
    "time": "2026-09-22T08:50:39.020Z",
    "node": "v24.18.0"
  }
}
```

### 6.2 GET / POST /api/permission

**GET** 返回当前请求的权限级别（无需鉴权）：

```json
{
  "ok": true,
  "data": { "level": 3, "role": "user", "secretRequired": true, "reason": "anonymous" }
}
```

**POST** 提交密钥摘要提升权限：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `digest` | 是 | 密钥的 SHA-256 摘要，64 位小写十六进制（算法见 [§2](#2-鉴权与权限级别)） |

```bash
DIGEST=$(printf '%s' "$SECRET" | sha256sum | cut -d' ' -f1)
curl -s -X POST http://127.0.0.1:8080/api/permission \
  -H 'content-type: application/json' \
  -d "{\"digest\":\"$DIGEST\"}"
```

```json
{ "ok": true, "data": { "level": 0, "role": "super", "secretRequired": true, "reason": "digest" } }
```

- 摘要不正确返回 `401`：`{"code":"unauthorized","message":"服务密钥不正确"}`
- 摘要格式非法返回 `422`：`{"code":"validation_error","message":"digest 必须是密钥的 SHA-256 十六进制摘要"}`
- 服务端未配置密钥返回 `401`：`{"code":"unauthorized","message":"服务端未配置服务密钥（INDEX_SRV_SECRET），无法提升权限"}`
- 来源不在 `server.permissionAllowlist` 内返回 `403`：`{"code":"forbidden","message":"当前来源地址不在权限提升白名单内（server.permissionAllowlist）"}`
- **每次提升尝试都会留痕**（应用日志，见 `docs/arch.md#55-日志`）：放行记 `info`、拦下记 `warn`，消息形如 `权限切换 3 user -> 0 super pass` / `3 user -> 0 super block`。字段：`ip`（TCP 对端真实地址，不信任 XFF）、`xForwardedFor` / `xRealIp`（请求携带时原样记录，便于对照代理链路）、`result`（`pass` / `block`）、`reason`（`digest` / `digest-mismatch` / `allowlist` / `invalid-digest` / `unconfigured`）
- **降级（`0 → 3`）不产生服务端日志**：它是客户端清掉本地摘要的动作，服务端不保存任何会话状态（见 [§2](#2-鉴权与权限级别)）；服务端的日志只覆盖「提升」这一个动作
- 该接口**本身不需要鉴权**（摘要即凭据）。服务端不保存任何会话状态：客户端把摘要存在本地，后续请求以 `x-service-digest` 带上；界面上点击权限组件时，`3 → 0` 弹窗输入密钥、`0 → 3` 清掉本地摘要

### 6.3 GET /api/config

返回面板设置与运行信息。

```json
{
  "ok": true,
  "data": {
    "settings": {
      "title": "Index Services",
      "description": "个人云服务索引面板",
      "theme": "auto",
      "accent": "neutral",
      "showDescription": true,
      "showTags": true,
      "openInNewTab": true
    },
    "runtime": {
      "name": "index-srv",
      "version": "0.1.0",
      "uptimeSeconds": 12,
      "startedAt": "2026-09-22T08:48:31.134Z",
      "secretRequired": false,
      "configFile": "/opt/index-srv/src/config/default.json",
      "serviceSchemaFile": "/opt/index-srv/data/conf/service.schema.json",
      "serviceSchemaSource": "file",
      "dataFiles": {
        "settings": "/opt/index-srv/data/conf/settings.json",
        "namespaces": "/opt/index-srv/data/section/namespace.json",
        "sites": "/opt/index-srv/data/section/service.json"
      }
    }
  }
}
```

`settings` 字段说明：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `title` | string | `Index Services` | 页头标题 |
| `description` | string | `个人云服务索引面板` | 面板描述 |
| `theme` | `auto` \| `light` \| `dark` | `auto` | 默认模式（客户端本地选择优先） |
| `accent` | string | `neutral` | 强调色，取值见 `docs/ui.md` |
| `showDescription` | boolean | `true` | 详情面板是否展示 `description` |
| `showTags` | boolean | `true` | 详情面板是否展示 `tags` |
| `openInNewTab` | boolean | `true` | 链接是否新标签页打开 |

> v0.1.0 移除了 `settings.layout`（`grid` / `list`）：新界面为「左侧目录 + 右侧详情」固定布局，不再有网格/列表切换。

### 6.4 PUT /api/config

局部更新，只需传需要变更的字段，未出现的字段保持不变。

```bash
curl -X PUT http://127.0.0.1:8080/api/config \
  -H 'content-type: application/json' \
  -H "x-service-digest: $DIGEST" \
  -d '{"title":"家庭服务台","theme":"dark","accent":"blue"}'
```

响应为更新后的完整 `settings` 对象。字段非法（如 `theme` 不在枚举内）返回 `422`。

### 6.5 GET /api/nav

UI 首屏专用聚合接口，**一次请求**即可完成渲染（设置 + 权限 + 命名空间 + 服务 + 统计）。

```json
{
  "ok": true,
  "data": {
    "settings": { "...": "同 /api/config" },
    "serviceSchema": { "name": "", "url": "", "description": "", "icon": "", "tags": [], "status": "running", "attributes": {}, "order": 0, "enabled": true },
    "permission": { "level": 3, "role": "user", "secretRequired": true, "reason": "anonymous" },
    "namespaces": [
      { "id": "ns-monitor", "name": "监控", "description": "指标、日志与告警", "order": 0, "serviceCount": 3 }
    ],
    "sites": [
      {
        "id": "s-grafana",
        "namespaceId": "ns-monitor",
        "name": "Grafana",
        "url": "http://127.0.0.1:3000",
        "description": "指标可视化看板",
        "icon": "",
        "tags": ["metrics", "dashboard"],
        "status": "running",
        "attributes": { "port": 3000, "version": "11.2.0", "owner": "ops" },
        "order": 0,
        "enabled": true
      }
    ],
    "stats": {
      "namespaces": 3,
      "services": 8,
      "disabledServices": 0,
      "running": 5,
      "stopped": 1,
      "coming": 1,
      "developing": 1,
      "updatedAt": "2026-09-22T00:00:00.000Z"
    }
  }
}
```

差异点：

- `sites` 已过滤 `enabled: false` 的服务；`disabledServices` 为其数量。
- `namespaces` 保留全部命名空间（含空命名空间，`serviceCount` 为 0）。
- `stats.running` / `services` 即页脚展示的 `running/services`。
- `permission` 与 `GET /api/permission` 同构，页头据此显示权限级别。

### 6.6 服务接口

**GET /api/sites** — 查询参数：

| 参数 | 说明 |
| --- | --- |
| `namespace` | 按 `namespaceId` 精确过滤 |
| `tag` | 按标签精确过滤 |
| `status` | 按状态精确过滤：`running` / `stopped` / `coming` / `developing` |
| `q` | 关键字模糊匹配 `name` / `description` / `url` / `status` / `tags` / `attributes` 的键与值（不区分大小写） |
| `enabled` | `true` / `false`，省略则返回全部（含未启用） |

```json
{
  "ok": true,
  "data": {
    "total": 2,
    "items": [{ "id": "s-grafana", "name": "Grafana", "url": "http://127.0.0.1:3000", "status": "running" }],
    "updatedAt": "2026-09-22T00:00:00.000Z"
  }
}
```

**POST /api/sites**

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `id` | 否 | 最长 64，需唯一 |
| `name` | 是 | 1–64 字符 |
| `url` | 是 | 必须为 `http` / `https`，最长 2048；会被规范化为标准形式 |
| `namespaceId` | 否 | 需已存在，省略则归入第一个命名空间 |
| `description` | 否 | 最长 200 字符 |
| `icon` | 否 | `http` / `https` 图片地址 |
| `tags` | 否 | 字符串数组，自动去重，最多 20 个，单项最长 32 |
| `status` | 否 | `running`（默认）/ `stopped` / `coming` / `developing` |
| `attributes` | 否 | JSON 对象，最多 50 个键；键非空且最长 64。值支持字符串（最长 500）/ 有限数字 / 布尔 / `null`，以及嵌套的数组与对象：每个容器最多 50 项、容器内的键同样非空且最长 64、整体最深 4 层（值本身算第 1 层） |
| `order` | 否 | 数字，省略则追加到所在命名空间末尾 |
| `enabled` | 否 | 布尔，默认 `true`；`false` 时不在 `/api/nav` 中返回 |

> **模型之外的顶层字段**：请求体里未列出的顶层键会被**原样写入数据文件** —— 不校验、不解析、面板也不展示，因此可以把面板还不认识的字段先寄存在记录里。同名键不会覆盖上面的模型字段（以校验后的值为准）；`PUT` / `PATCH` 同样透传这类键，且不会丢弃记录里已有的自定义字段。

```bash
curl -X POST http://127.0.0.1:8080/api/sites \
  -H 'content-type: application/json' \
  -d '{
    "id": "s-grafana",
    "name": "Grafana",
    "url": "http://127.0.0.1:3000",
    "namespaceId": "ns-monitor",
    "status": "running",
    "tags": ["metrics"],
    "attributes": { "port": 3000, "version": "11.2.0", "agent": true, "endpoints": ["a", "b"], "limits": { "cpu": 2 } }
  }'
```

成功返回 `201` 与新建的服务对象。非法 `status`、超长的属性值或越界的属性嵌套：

```json
{ "ok": false, "error": { "code": "validation_error", "message": "status 只能是 running / stopped / coming / developing", "details": { "field": "status" } } }
{ "ok": false, "error": { "code": "validation_error", "message": "attributes.agent 长度不能超过 500", "details": { "field": "attributes", "key": "attributes.agent" } } }
{ "ok": false, "error": { "code": "validation_error", "message": "attributes.limits.l1.l2.l3.l4 嵌套不能超过 4 层", "details": { "field": "attributes", "key": "attributes.limits.l1.l2.l3.l4" } } }
```

> 属性值的类型会直接决定界面上的展示形式：基本类型为常规文本、数组为 chunk 分块、对象为 JSON 代码块；`null`、空字符串与空数组显示为 `—`。详见 [ui.md §7](ui.md#7-渲染流程)。

**PUT / PATCH /api/sites/:id** — 局部更新，字段同创建，仅更新请求体中出现的字段。

```bash
# 标注为「开发中」并补一个属性
curl -X PATCH http://127.0.0.1:8080/api/sites/s-alertmanager \
  -H 'content-type: application/json' \
  -d '{"status":"developing","attributes":{"channel":"#alerts"}}'

# 下线某服务（保留配置）
curl -X PATCH http://127.0.0.1:8080/api/sites/s-grafana \
  -H 'content-type: application/json' \
  -d '{"enabled":false}'
```

> `attributes` 为整体替换：传入的对象会替换原有属性，传 `{}` 表示清空。

**PUT /api/sites/order** — 批量排序：

```bash
curl -X PUT http://127.0.0.1:8080/api/sites/order \
  -H 'content-type: application/json' \
  -d '{"ids":["s-grafana","s-prometheus","s-alertmanager"]}'
```

### 6.7 命名空间接口

**GET /api/namespaces** — 返回按 `order` 升序排列的命名空间数组，每项附带 `serviceCount`。

**POST /api/namespaces**

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `id` | 否 | 最长 64，需全局唯一，重复返回 `409` |
| `name` | 是 | 1–64 字符 |
| `description` | 否 | 最长 200 字符 |
| `order` | 否 | 数字，省略则追加到末尾 |

```bash
curl -X POST http://127.0.0.1:8080/api/namespaces \
  -H 'content-type: application/json' \
  -d '{"id":"ns-storage","name":"存储","description":"NAS 与备份"}'
```

成功返回 `201` 与新建的命名空间对象。

**PUT / PATCH /api/namespaces/:id** — 局部更新 `name` / `description` / `order`。

**PUT /api/namespaces/order** — 批量排序，数组下标即为新的 `order`：

```bash
curl -X PUT http://127.0.0.1:8080/api/namespaces/order \
  -H 'content-type: application/json' \
  -d '{"ids":["ns-tools","ns-monitor","ns-infra"]}'
```

### 6.8 数据备份与恢复

**GET /api/store** — 导出完整数据（含 `settings`、全部服务，包含未启用项）：

```bash
curl -s http://127.0.0.1:8080/api/store -o backup.json
```

**PUT /api/store** — 覆盖式导入，可直接复用上面的导出文件（同时兼容完整响应 `{ ok, data }` 与数据本体两种载荷）。

语义约定：

- 仅当请求体中出现 `settings` / `namespaces` / `sites` 时才替换对应部分，未出现的部分保持原值（因此可以只导入命名空间）；
- 三者都不存在时返回 `422`；`namespaces` / `sites` 非数组同样返回 `422`；
- `namespaces` / `sites` 提供后即为整体替换，传入空数组 `[]` 表示清空；
- 兼容 v1 备份：请求体中的 `groups` 会被当作 `namespaces` 处理。

```bash
curl -X PUT http://127.0.0.1:8080/api/store \
  -H 'content-type: application/json' \
  -H "x-service-digest: $DIGEST" \
  --data-binary @backup.json
```

响应中的 `replaced` 指出本次实际替换的部分：

```json
{
  "ok": true,
  "data": {
    "replaced": ["settings", "namespaces", "sites"],
    "namespaces": 3,
    "sites": 8,
    "updatedAt": "2026-09-22T09:10:00.000Z"
  }
}
```

> 导入前建议先备份三份分区文件：`cp -r data data.bak`（或先 `GET /api/store` 导出一份）。导入的数据会经过一次规范化：缺失字段补默认值、指向不存在命名空间的服务会回落到第一个命名空间（不会丢数据），随后按分区写回。

### 6.9 说明文档接口

说明文档是 `data/intro` 下的 Markdown（路径由 `storage.introPath` 配置）。服务端**只发原文**，渲染在浏览器端用 vendored 的 marked 完成 —— 因此这两个接口与鉴权、数据分区都无关，是纯只读的。

**GET /api/intro** — 列出文档：

```json
{
  "ok": true,
  "data": {
    "mode": "dir",
    "items": [
      { "id": "01-overview.md", "name": "项目概览" },
      { "id": "02-usage.md", "name": "使用说明" }
    ]
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `mode` | `dir` = 配置的路径是目录（多篇，前端渲染 sidebar + 内容）；`file` = 单个 `.md`（只渲染内容）；`none` = 路径不存在（前端隐藏入口） |
| `items[].id` | 文件名，取单篇内容时用它 |
| `items[].name` | 展示名：来自 frontmatter 的 `label`，缺省回落为去掉扩展名与序号前缀的文件名 |

每篇 `.md` 开头都应带 frontmatter（`---` 包围），侧栏完全由它控制：

```yaml
---
label: '使用说明'   # 侧栏展示名（缺省回落为文件名去掉扩展名与前导序号）
order: 2           # 升序排序，缺省排最后（同序按文件名）
hidden: false      # true 时不进入侧栏（单篇接口仍可访问）
---
```

列表由服务端定稿：按 `order` 升序、过滤 `hidden`，前端拿到即用，不再排序或过滤。frontmatter 只影响侧栏，不属于正文 —— 单篇接口返回的是剥掉 frontmatter 后的 Markdown 原文。

**GET /api/intro/:id** — 取单篇内容：

```json
{
  "ok": true,
  "data": { "id": "02-usage.md", "name": "使用说明", "content": "# 使用说明\n\n## 搜索与快捷键\n…" }
}
```

`id` 只能是 `[A-Za-z0-9_.-]` 组成且以 `.md` 结尾的文件名：含路径分隔符、绝对路径或 `../` 的请求一律拒绝（404 / 422），不会读到目录之外的任何文件。

---

## 7. 完整示例：新增一个服务并置顶

```bash
BASE=http://127.0.0.1:8080/api

# 1. 新建（含状态与自定义属性）
curl -s -X POST $BASE/sites -H 'content-type: application/json' \
  -d '{
    "id": "s-navidrome",
    "name": "Navidrome",
    "url": "https://music.example.com",
    "namespaceId": "ns-tools",
    "status": "coming",
    "tags": ["music"],
    "description": "音乐流媒体",
    "attributes": { "port": 4533, "tls": true }
  }'

# 2. 读取当前顺序
curl -s "$BASE/sites?namespace=ns-tools" | grep -o '"id":"[^"]*"'

# 3. 置顶
curl -s -X PUT $BASE/sites/order -H 'content-type: application/json' \
  -d '{"ids":["s-navidrome","s-ttyd","s-code-server"]}'

# 4. 只看「开发中」的服务
curl -s "$BASE/sites?status=developing"

# 5. 校验首屏数据
curl -s $BASE/nav | head -c 400
```

---

## 8. 附：数据文件结构

数据按语义拆成三份文件，各自带版本与时间戳，可独立编辑：

- `data/conf/settings.json` —— 面板设置（配置类）
- `data/section/namespace.json` —— 命名空间
- `data/section/service.json` —— 服务

另有一份**配置类**文件 `data/conf/service.schema.json`：它是「新建服务」的草稿骨架（不参与上面三份分区的写回，也不带版本与时间戳，因为由运维手工维护）。服务启动时读入并由 `GET /api/nav` 的 `serviceSchema` 下发；加一个字段，新建草稿里就多一个占位。缺失或不是 JSON 对象时回落到内置骨架，来源见 `GET /api/config` 的 `runtime.serviceSchemaSource`（`file` / `default` / `invalid`）。它不含 `namespaceId` —— 归属由客户端按点开的命名空间注入，文件里即使写了也会被忽略。

```json
// data/conf/settings.json
{
  "version": 3,
  "updatedAt": "2026-09-22T00:00:00.000Z",
  "settings": {
    "title": "Index Services",
    "description": "个人云服务索引面板",
    "theme": "auto",
    "accent": "neutral",
    "showDescription": true,
    "showTags": true,
    "openInNewTab": true
  }
}
```

```json
// data/section/namespace.json
{
  "version": 3,
  "updatedAt": "2026-09-22T00:00:00.000Z",
  "namespaces": [{ "id": "ns-monitor", "name": "监控", "description": "指标、日志与告警", "order": 0 }]
}
```

```json
// data/section/service.json
{
  "version": 3,
  "updatedAt": "2026-09-22T00:00:00.000Z",
  "services": [
    {
      "id": "s-grafana",
      "namespaceId": "ns-monitor",
      "name": "Grafana",
      "url": "http://127.0.0.1:3000",
      "description": "指标可视化看板",
      "icon": "",
      "tags": ["metrics", "dashboard"],
      "status": "running",
      "attributes": { "port": 3000, "version": "11.2.0", "owner": "ops" },
      "order": 0,
      "enabled": true
    }
  ]
}
```

三份文件在启动时汇总为接口里的 `settings` / `namespaces` / `sites`（`services` ↔ `sites` 只是文件与接口的命名差异）。文件可手工编辑；每次读写都会做一次规范化，容错字段缺失。

写回按分区进行：一次写操作只回写内容确实变化的那一份，其余文件不动（连 `updatedAt` 都不刷新），接口里的聚合 `updatedAt` 取各分区最新值。

服务记录允许携带**模型之外的顶层字段**：`id` / `namespaceId` / `name` / `url` / `description` / `icon` / `tags` / `status` / `attributes` / `order` / `enabled` 之外的键会被原样保留到文件里，接口读写往返不丢，但面板不解析、不展示 —— 可用来把 `owner`、`meta` 之类的信息与记录放在一起。v1 的遗留键 `groupId` 例外：它只在读取时映射为 `namespaceId`，不会再写回。

### 旧版单文件迁移（v2 → v3）

启动时若**分区文件缺失**、或文件里**没有声明该分区**（空壳 `{}`），会自动读取旧版单文件 `data/conf/sites.json`，把内容拆分落盘为上面三份文件；旧文件保留不动（确认无误后自行删除）。日志会记录 `数据已从旧版单文件迁移到分区文件`。

| 旧版单文件 | 现在 |
| --- | --- |
| `settings` | `conf/settings.json` |
| `namespaces`（v1 为 `groups`） | `section/namespace.json` |
| `sites` | `section/service.json`（键名 `services`） |
| `groups[]` | `namespaces[]` |
| `sites[].groupId` | `sites[].namespaceId` |
| `settings.layout` | 已移除（忽略） |
| 无 `status` | 补 `running` |
| 无 `attributes` | 补 `{}` |

迁移是幂等的：已经是分区形态、且各分区都有声明时不会被改动；从旧文件迁移过来的分区沿用旧文件的时间戳（迁移只是换存放形式，语义没变）。

注意：服务启动后数据常驻内存，运行中直接编辑该文件**不会生效**，且下一次写操作会以内存的旧数据覆盖文件。手工编辑后需重启服务（`docker compose restart index-srv`，本地直跑则重启进程）使其生效；通过 API 修改则无需重启。
