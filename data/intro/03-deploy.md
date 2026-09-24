---
label: '部署与数据'
order: 3
hidden: false
---

# 部署与数据

## 两种部署方式

```bash
npm start                      # 本地直跑（改代码用 npm run dev）：Node 同时提供页面与 API
docker compose up -d --build   # 容器部署：前后端分离（nginx + node），对外是 https
```

容器部署会起两个容器：**web**（`nginx:stable-alpine`，TLS 终结 + 静态资源 + `/api` 反向代理）与 **api**（Node，只提供 API）。`api` 不发布端口，外部只能经 nginx 访问。

## 证书与访问

证书放在 `~/.ssl`（`server.crt` / `server.key` / `ca.crt`），由 compose 挂载进 web 容器；`ca.key` 不进任何容器，只留在宿主机用于签发与续期。

- 生成方式（带 **IP SAN** 的自签证书）与导入信任的步骤见 `readme.md` 的部署章节；
- 80 端口只做 301 跳转到 https；
- 浏览器处于 https（安全上下文）是**算密钥摘要的前提**，因此容器部署下权限提升链路可直接使用；
- 可选双向 TLS：打开 `deploy/nginx.conf` 里注释的两行，让只有装了客户端证书的设备才能连接。

## 白名单与来源地址

- 后端看到的 socket 对端是 nginx 容器，因此 `.env` 里的 `INDEX_SRV_TRUSTED_PROXIES`（默认 panel 子网 `172.28.0.0/24`）必须与实际子网一致 —— 它决定后端是否采信 `X-Forwarded-For` 还原真实客户端；
- 只在可信代理之后才采信 XFF，且只取最右一项（nginx 亲眼看到的那一跳）——不向左回溯，客户端伪造的值永远不会被当成真实客户端；
- 于是 `server.permissionAllowlist`（默认回环 + RFC 1918）判定的就是真实客户端地址，例如只放行 WireGuard 内网可设 `INDEX_SRV_PERMISSION_ALLOWLIST=10.0.0.0/8`。

## 数据文件

| 文件 | 内容 |
| --- | --- |
| `data/conf/settings.json` | 面板标题、默认主题与显示开关 |
| `data/section/namespace.json` | 命名空间 |
| `data/section/service.json` | 服务 |
| `data/conf/service.schema.json` | 新建服务的草稿骨架 |
| `data/intro/*.md` | 本说明（Markdown） |

数据常驻内存：**手工编辑这些文件后需重启服务**才生效（通过 API 修改则无需重启）。容器部署下 `./data` 挂载到 api 容器，删除容器不会丢数据；`api` 以 uid 1000 运行，宿主机 `data/` 属主不符时需调整（见 `readme.md`）。

## 备份

```bash
cp -r data data.bak
curl -sk https://127.0.0.1/api/store -o backup.json
```
