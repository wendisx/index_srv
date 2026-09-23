---
label: '项目概览'
order: 1
hidden: false
---

# 项目概览

## 简述

index srv 是一个**轻量级服务索引面板**：用一个页面收纳散落在云服务器上的各种服务（面板、网关、存储、工具），支持多主题与灵活配置。

- 后端是**零依赖的 Node.js HTTP 服务**（仅使用 Node 内置模块）
- 前端是**纯原生 HTML / CSS / JavaScript**（无框架、无构建步骤）
- 整个项目的运行依赖只有 Node.js 本身

## 项目功能

| 领域 | 说明 |
| --- | --- |
| 服务索引 | 命名空间分组、标签、状态、排序、启用/下线、搜索与整份导入导出 |
| 详情展示 | `key: value` 属性按类型选组件：基本类型文本、数组分块、对象 JSON 代码块、`status` 色调块、`url` 可点击链接 |
| 权限控制 | `3` user（只读）/ `0` super（可写）；配置密钥后输入即可提升，浏览器只提交 SHA-256 摘要，服务端不保存明文 |
| 主题系统 | 亮 / 暗 / 跟随系统三态切换，7 种强调色，偏好持久化在浏览器本地 |
| 说明文档 | 即本弹窗：`data/intro/` 下的 Markdown，由每篇开头的 frontmatter 控制侧栏 |

界面结构：页头（权限、标题、搜索、主题与模式切换、刷新、说明）+ 左侧命名空间目录树 + 右侧属性详情 + 页脚统计（`LAST MODIFY`）。

## 项目结构

核心约定：**`src/` 放代码与服务端配置，`data/` 放运行期数据**，二者不混用 —— 容器部署时只需挂载 `data/` 一个目录即可完成持久化。

```text
index_srv/
├── src/        # 服务端（server.js + core/ + api/ + config/）与前端（web/）源码
├── data/       # 运行期数据：conf/ 配置、section/ 分区数据、intro/ 说明、log/ 日志
├── docs/       # 架构（arch.md）、接口（api.md）、界面约定（ui.md）
├── tests/      # 静态契约 / 纯逻辑 / 渲染快照 / 文档一致性 / 端到端冒烟
└── scripts/    # 开发期生成工具（图标精灵等）
```

完整的架构图与模块明细见 `docs/arch.md`。

## 项目依赖

- **运行期零依赖**：后端只用 Node 内置模块，前端只用浏览器原生能力，运行与部署都不需要 `npm install`
- **vendored 第三方源码**：`marked`（Markdown 解析）与 `CodeJar`（JSON 编辑器）以源码形式随仓库提交（`src/web/vendor/`）
- **开发期 devDependencies**：仅 `lucide-static`（生成图标精灵）与 `codejar`（供 vendoring），只产出提交进仓库的文件
- **容器镜像**：基于 `node:lts-alpine3.23`（Node 24 LTS）
