---
label: '部署与数据'
order: 3
hidden: false
---

# 部署与数据

## 两种部署方式

```bash
npm start                      # 本地直跑（改代码用 npm run dev）
docker compose up -d --build   # 容器部署
```

## 数据文件

| 文件 | 内容 |
| --- | --- |
| `data/conf/settings.json` | 面板标题、默认主题与显示开关 |
| `data/section/namespace.json` | 命名空间 |
| `data/section/service.json` | 服务 |
| `data/conf/service.schema.json` | 新建服务的草稿骨架 |
| `data/intro/*.md` | 本说明（Markdown） |

数据常驻内存：**手工编辑这些文件后需重启服务**才生效（通过 API 修改则无需重启）。

## 备份

```bash
cp -r data data.bak
curl -s http://127.0.0.1:8080/api/store -o backup.json
```
