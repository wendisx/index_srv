---
label: '项目配置'
order: 4
hidden: false
---

# 项目配置

## 环境变量

命名统一为 `INDEX_SRV_*`，优先级高于配置文件。常用：

| 变量 | 对应配置 | 说明 |
| --- | --- | --- |
| `INDEX_SRV_PORT` | `server.port` | 监听端口（默认 8080） |
| `INDEX_SRV_HOST` | `server.host` | 监听地址 |
| `INDEX_SRV_SECRET` | — | 服务密钥，**只从环境变量读取**、不落配置文件；留空则接口整体只读 |
| `INDEX_SRV_DATA_DIR` | `storage.dataDir` | 数据根目录 |
| `INDEX_SRV_INTRO` | `storage.introPath` | 说明文档路径（相对 dataDir）：目录 → 多篇带目录栏，单个 `.md` → 只有一篇 |
| `INDEX_SRV_PERMISSION_ALLOWLIST` | `server.permissionAllowlist` | 权限提升白名单（逗号分隔的 IP / CIDR），设置后整份覆盖配置文件里的列表；留空时沿用配置文件（默认即回环 + 内网段） |
| `INDEX_SRV_LOG_LEVEL` | `log.level` | 日志级别（debug / info / warn / error） |

其余变量：`INDEX_SRV_CONFIG`（指定另一份配置文件）、`INDEX_SRV_ROOT`（项目根目录）、`INDEX_SRV_REQUEST_LIMIT`（请求体上限）、`INDEX_SRV_CORS_ORIGINS`（逗号分隔的来源列表，设置后自动开启 CORS）、`INDEX_SRV_LOG_DIR`、`INDEX_SRV_WEB_DIR`、`INDEX_SRV_WEB_CACHE`。

## 文件配置

| 文件 | 性质 | 内容 |
| --- | --- | --- |
| `src/config/default.json` | 服务端内置 | 端口、路径、日志、CORS 等基础配置（随代码分发） |
| `data/conf/settings.json` | 运行期配置 | 面板标题、默认主题、显示开关（由界面或 `PUT /api/config` 修改） |
| `data/conf/service.schema.json` | 运行期配置 | 新建服务的草稿骨架，可手工扩展字段 |
| `data/section/*.json` | 运行期数据 | 命名空间与服务清单（业务数据，不是配置） |

约定：`src/` 放代码与服务端配置，`data/` 放运行期数据 —— 改 `src/config/` 需要重启，`data/` 下的内容由接口即时写回。

## 默认配置

来自 `src/config/default.json`，未被覆盖时生效：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `server.host` | `0.0.0.0` | 监听所有网卡 |
| `server.port` | `8080` | 服务端口 |
| `server.requestLimitBytes` | `262144` | 请求体上限（256 KiB） |
| `server.cors` | 关闭 | 未配置来源时不返回 CORS 头 |
| `server.permissionAllowlist` | 回环 + 内网段 | 只放行 `127.0.0.0/8`、`::1`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` 的来源；公网来源调提升接口返回 403（填 `[]` 表示不限制） |
| `storage.dataDir` | `data` | 数据根目录（下含 `conf/` `section/` `intro/` `log/`） |
| `web.cacheMaxAge` | `0` | 静态资源 no-cache + ETag 协商缓存 |
| `log.level` | `info` | stdout 文本 + 文件 JSON Lines，按天切分 |

## 优先级规则

1. **内置默认**（`src/config/default.json`）是底线，任何未覆盖的项都用它；
2. **环境变量**（`INDEX_SRV_*`）逐项覆盖默认值 —— 这是容器与本地部署的标准做法，空字符串视为未设置；
3. **运行期数据**（`data/` 下）不属于配置分层：它是面板内容本身，由接口读写，启动时加载进内存、写操作串行化后原子落盘。

两个特例需要记住：

- **服务密钥只在环境变量里**（`INDEX_SRV_SECRET`），放进任何配置文件都无效；且只在启动时读取一次，内存中只保留它的 SHA-256 摘要；
- **`INDEX_SRV_CONFIG` 可以整体换掉默认配置文件**，此时的优先级链变为：指定配置文件 → 环境变量；
- **列表型配置（CORS 来源、权限提升白名单）是「整份覆盖」而不是逐项合并**：环境变量给了列表就用它，留空则继续用配置文件里的列表。`server.permissionAllowlist` 需要特别记住的一点是：**它只拦「提升」这一个动作**，写操作仍以密钥摘要为准，判定用的是 TCP 连接的对端地址（不信任 `X-Forwarded-For`）。
