# index-srv Web UI 说明

前端位于 `src/web/`，**零框架、零构建、零 npm 依赖**，全部使用浏览器原生能力（ES Module + CSS 自定义属性 + `<template>`）。本文记录结构约定与扩展方式；整体架构与前后端交互时序见 [arch.md](arch.md)。

---

## 1. 设计原则

| 原则 | 落地方式 |
| --- | --- |
| 纯原生 | 不使用 Vue/React/Svelte 等框架，不使用打包器，浏览器直接加载源码 |
| 三段式布局 | `header` / `main` / `footer`，内容宽度统一由 `.shell` 约束为视口的 **80%** |
| 结构与样式隔离 | HTML 中不允许出现 `<style>` 块、`style=""` 属性与内联事件；样式一律外部 `<link>` |
| 无动效 | CSS 中不出现 `transition` / `animation` / `@keyframes` / `will-change` |
| 直角风格 | `--radius: 0px`，所有 `border-radius` 统一引用该变量 |
| 默认风格 | 色彩体系对齐 shadcn/ui 默认主题（zinc / neutral 灰阶） |
| 图标统一 | 使用 lucide 图标集，开发期生成 `icons/sprite.svg`，页面内不手写 SVG 路径、不引 CDN |
| 安全渲染 | 所有动态内容经 `textContent` 写入，不使用 `innerHTML` |

---

## 2. 目录结构

```
src/web/
├── index.html            # 唯一页面：三段式结构 + <template> 模板 + 图标引用
├── favicon.svg           # 站点图标（直角风格，手工维护的品牌标记）
├── assets/
│   ├── bg-light.png      # 页面底图 · 亮色（1920×1080）
│   └── bg-night.jpg      # 页面底图 · 暗色（1920×1080）
├── icons/
│   └── sprite.svg        # 图标精灵（npm run icons 生成，勿手工编辑）
├── vendor/
│   └── codejar.js        # CodeJar（npm run vendor 从 node_modules 复制，勿手工编辑）
├── css/
│   ├── theme.css         # 设计令牌：明暗主题、强调色、状态色、字体、间距、形体
│   ├── base.css          # 重置、排版、通用工具类（.shell / .sr-only / .icon）
│   └── components.css    # 组件样式：页头、权限框、目录树、详情、页脚
└── js/
    ├── theme-init.js     # <head> 同步脚本：首屏预设主题，避免闪烁
    ├── dom.js            # 最底层 DOM 工具：查询、填充、显隐、防抖
    ├── intro.js          # 说明弹窗：Markdown → DOM（vendored 的 marked + 清洗，不用 innerHTML）
    ├── view.js           # 视图基元：模板取节点、空态、状态文案（供多个渲染模块复用）
    ├── api.js            # /api 客户端：响应体解包、错误抛出、密钥摘要读写
    ├── digest.js         # 密钥摘要：Web Crypto 的 SHA-256（与服务端同算法）
    ├── theme.js          # 主题管理器：模式切换、强调色、持久化
    ├── render.js         # 渲染层：数据 -> 左侧目录树
    ├── detail.js         # 渲染层：选中服务 -> 右侧 key: value 详情（值渲染管道按类型选组件）
    ├── alert.js          # 提示消息：右上角浮层，自动关闭 + 点击关闭
    ├── editor.js         # 服务 JSON 编辑器：挂载 CodeJar + 最小 JSON 高亮 + 草稿校验
    └── app.js            # 应用入口：装配数据、事件、权限与渲染
```

加载顺序（见 `index.html`）：

```
1. 三个 css 外链        → 样式先于内容解析，避免无样式闪烁
2. js/theme-init.js     → <head> 内同步经典脚本，在首次绘制前写入主题属性
3. js/app.js            → type="module"，浏览器自动 defer，不阻塞解析
4. icons/sprite.svg     → 不写在 head 中，由页面的 <use> 触发按需加载并缓存
```

---

## 3. 页面结构

```
┌─ header ───────────────────────────────────────────────────────────┐
│ [权限方框] 站点标题        搜索框 · 主题选择器 · 模式切换 · 刷新    │
├─ main ─────────────────────────────────────────────────────────────┤
│ ┌─ sidebar ────────┐ ┌─ detail ─────────────────────────────────┐ │
│ │ namespace   3 [+]│ │ 服务名                        [->]        │ │
│ │ ▾ 监控      3 [+]│ │ namespace : 监控                         │ │
│ │    ▎Grafana      │ │ status    : [运行中]                     │ │
│ │    ▎Prometheus   │ │ url       : http://127.0.0.1:3000        │ │
│ │ ▸ 基础设施  3 [+]│ │ ... 自定义 attributes ...                │ │
│ └──────────────────┘ └───────────────────────────────────────────┘ │
├─ footer ───────────────────────────────────────────────────────────┤
│ namespace 3        running 5/8                 LAST MODIFY …      │
└────────────────────────────────────────────────────────────────────┘
```

页头是**半透明层**：`--header-veil` 让底图在页头处也透出来，与主体连成同一张背景；同时用 `backdrop-filter: blur(10px)` 把背后经过的内容糊掉 —— 少了模糊，滚过去的正文会与页头文字互相干扰，半透明反而比不透明更难读。不支持该属性的浏览器回落到更高的不透明度（`.app-header` 的兜底规则），因此**页头永远不是全透明**。

当前取值 **50% 透明**：正文对比度在最坏情况下仍有 **12:1**（AA 要求 4.5:1，`check-static` 硬性拦截）；而 secondary 文字（`--muted-foreground`）落到 **2.93:1**，略低于非文本门槛 3:1 —— 这是刻意选定的取值，所以检查对它**只提示、不拦截**，并反解出达标所需的不透明度（`--header-veil ≥ 0.53`）。理论上限用「纯黑/纯白底图」算，与实测底图一致：浅色底图（`bg-light.png`）顶部覆盖带里最暗的像素是 `#00030f`，几乎等同纯黑。

- `main` 为左右两栏；`sidebar` 固定 `--sidebar-width` 宽并独立滚动，`detail` 占满剩余宽度。
- `900px` 以下改为上下堆叠：目录在上、详情在下。
- 提示消息（`#toasts`）与输入弹窗（`#perm-modal`）都不占布局：前者是 `body` 末尾右上角的固定浮层（同一时刻只保留一条），后者是全屏遮罩式的居中弹窗。
- 图中的 `[+]` 是写入口，**仅当权限为 `0`（super）时出现**：侧栏头部一个（新建命名空间），每个命名空间行尾一个（添加服务）。只读权限下这些按钮不渲染出来（`hidden`）。
- 侧栏右侧的两列（**计数徽标**、**新增按钮**）在头部与每个 namespace 行上都是同一竖直列：徽标与按钮同为 20px、间距同为 `--space-1`，右侧内边距由「头部 16px」与「`.tree` 8px + `.node__row` 8px」两侧凑齐。改动其中任一侧都要同步另一侧（`.sidebar__head` 上有这段对齐账的注释）。
  - 这段留白**必须挂在容器上**（`.node__row` 的 `padding-right`），不能挂在写入口按钮的 `margin` 上：只读权限（`3` user）下按钮被移出布局，挂在按钮上的留白会一同消失，行计数就会比头部的总数多缩进 8px。静态检查里有对应断言拦住这种改法。

---

## 4. CSS 分层与命名

三层职责严格分离，样式文件之间不互相覆盖：

| 文件 | 允许出现的内容 |
| --- | --- |
| `theme.css` | 仅 `:root` / `[data-theme]` / `[data-accent]` 选择器下的自定义属性定义 |
| `base.css` | 元素选择器、`.shell` / `.sr-only` / `.icon` 等通用工具类 |
| `components.css` | 具体的块级组件、修饰符，以及 `[data-*]` 驱动的状态样式 |

命名采用 BEM 风格的扁平写法，不使用嵌套选择器：

```
.block                → .node
.block__element       → .node__head        （元素）
.block__element--mod  → .kv__value--mono   （元素修饰符）
.block--modifier      → .node--collapsed   （块修饰符）
```

CSS 变量命名沿用 shadcn/ui 约定，颜色值为 **HSL 分量**（不含 `hsl()` 包裹），使用时写成 `hsl(var(--border))`。

### 可用令牌一览（`theme.css`）

- 基础：`--background` `--foreground` `--card` `--card-foreground` `--muted` `--muted-foreground` `--accent` `--accent-foreground` `--border` `--input` `--ring`
- 强调色：`--primary` `--primary-foreground`
- **服务状态色**：`--status-running`（绿）/ `--status-stopped`（红）/ `--status-coming`（蓝）/ `--status-developing`（黄）
- 形体：`--radius` `--border-width` `--ring-width`
- 字体：`--font-sans` `--font-mono`
- 字号：`--text-xs` `--text-sm` `--text-base` `--text-lg` `--text-xl`
- 间距：`--space-1` … `--space-5`
- 布局：`--shell-width`（80%）`--sidebar-width` `--header-height`
- 页面底图：`--page-image` `--page-veil`（明暗主题各一张图片与对应的调淡叠层）
- 页头表面：`--header-veil`（sticky 页头的半透明层不透明度，当前 **0.5 = 50% 透明**；它直接决定页头文字与其背后底图的对比度 —— 改动后 `check-static` 会报出实算值与达标所需取值）
- 代码高亮：`--code-key` `--code-string` `--code-number` `--code-literal`（服务 JSON 编辑器专用）

新增组件请复用以上令牌，不要硬编码颜色与间距。

### 状态色的使用方式

`data-status` 会把状态色写进一个**局部变量** `--status-color`，因此同一个属性名既能驱动目录树色条，也能驱动详情里的状态徽标：

```html
<li class="svc" data-status="running">      <!-- 服务项：左侧色条取 --status-color -->
<span class="badge badge--status" data-status="stopped">  <!-- 详情徽标同源 -->
```

```css
[data-status="running"] { --status-color: var(--status-running); }
.svc__btn { border-left: 3px solid hsl(var(--status-color)); }
```

新增状态时只需在 `theme.css` 补一对亮/暗令牌，在 `components.css` 补一条 `[data-status="..."]` 规则，并在 `view.js` 的 `STATUS_LABELS` 登记文案。三者缺一都会出现「有颜色没文案」或反之。

---

## 5. 主题机制

主题完全由 `<html>` 上的数据属性驱动，CSS 不关心切换逻辑：

| 属性 | 取值 | 作用 |
| --- | --- | --- |
| `data-theme` | `light` \| `dark` | 决定明暗令牌。`auto` 会先被解析为这两者之一再写入 |
| `data-accent` | `neutral` \| `slate` \| `blue` \| `green` \| `violet` \| `amber` \| `rose` | 强调色 |

### 切换与持久化

- 用户偏好存于 `localStorage` 的 `index-srv:theme`，值为 `{"mode":"auto","accent":"neutral"}`。
- `js/theme-init.js` 与 `js/theme.js` 共用该键值结构（前者是同步经典脚本，用于消除首屏闪烁，故未做模块复用）。
- 「模式切换」按钮按 `auto → light → dark → auto` 循环；`auto` 模式监听 `prefers-color-scheme` 变化实时跟随。
- 「主题选择器」下拉切换强调色，即时生效并持久化。
- 优先级：**本地偏好 > 服务端 `settings.theme` / `settings.accent` > 内置默认值**。用户从未设置过时，`applyServerDefaults()` 才会采用服务端下发值。

### 暗色主题的分支写法

```css
:root { --background: 0 0% 100%; }                    /* 亮色 */
[data-theme="dark"] { --background: 240 10% 3.9%; }   /* 暗色 */
[data-accent="blue"] { --primary: 221.2 83.2% 53.3%; }
[data-theme="dark"][data-accent="blue"] { --primary: 217.2 91.2% 59.8%; }
```

新增颜色令牌时必须同时补齐亮色与暗色两组取值。

### 页面底图

底图由两个令牌驱动，**明暗主题各一张**：

| 令牌 | 亮色 | 暗色 | 说明 |
| --- | --- | --- | --- |
| `--page-image` | `url("../assets/bg-light.png")` | `url("../assets/bg-night.jpg")` | 底图本身；改成 `none` 即关闭（此时浏览器不会请求该图片） |
| `--page-veil` | `hsl(0 0% 100% / 0.58)` | `hsl(240 10% 3.9% / 0.58)` | 压在图片之上、内容之下的叠层：亮色下调淡、暗色下压暗，都在保住前景对比度 |

叠层取各自主题的底色（白 / 近黑）并统一用 `0.58` 的透明度，数值即「底图存在感」：调大更含蓄、调小更抢眼。

`base.css` 的 `body` 把两层叠起来并固定在视口上铺满（`background-attachment: fixed`）。面板与页头仍是**不透明**的，因此底图出现在主体四周、面板之间的间隙与页脚区域。

想让底图透进面板，把对应容器（`.sidebar` / `.detail` / `.app-header`）的背景色改成带 alpha 的写法即可，例如 `hsl(var(--card) / 0.86)`。

---

## 6. JavaScript 模块职责

| 模块 | 职责 | 关键导出 |
| --- | --- | --- |
| `theme-init.js` | 首屏写入 `data-theme` / `data-accent` | 无（IIFE） |
| `dom.js` | 最底层 DOM 工具，不认识业务概念 | `$` `cloneTemplate` `setText` `toggleHidden` `isHidden` `setTitle` `setLabel` `debounce` `isInteractiveTarget` |
| `view.js` | 视图基元：模板取节点、空态、状态文案 | `fromTemplate` `createEmpty` `statusLabel` |
| `alert.js` | 右上角提示消息：结构、定时自动关闭、点击关闭 | `showAlert` `dismissAlert` |
| `api.js` | 请求 `/api`，解包统一响应体，抛出带 `status` / `code` 的 Error；自动附带密钥摘要头 | `api` 对象：`nav` `config` `health` `store` `permission` `elevate` `listSites` `listNamespaces` `saveConfig` `createSite` `updateSite` `reorderSites` `createNamespace` `updateNamespace` `reorderNamespaces` `replaceStore` `setDigest` `getDigest`（不提供任何删除方法） |
| `digest.js` | 把密钥算成 SHA-256 摘要（与服务端一致，浏览器端用 Web Crypto） | `sha256Hex` `isDigestSupported` |
| `theme.js` | 主题状态机与持久化 | `createThemeManager` `ACCENTS` `MODE_LABELS` `ACCENT_LABELS` |
| `render.js` | 左侧目录树：namespace → service | `renderTree`（返回可见服务数） |
| `detail.js` | 右侧详情：行骨架 + 值渲染管道（按 key 与值类型选择组件） | `renderDetail` |
| `editor.js` | 服务 JSON 编辑器：挂载 CodeJar、最小 JSON 高亮、草稿骨架与校验（不碰网络） | `createJsonEditor` `createDraft` `formatDraft` `validateDraft` |
| `intro.js` | 说明弹窗的渲染：marked 解析 + 清洗后插入 DOM（取数据由 `app.js` 走 `api.js`） | `renderIntro` `renderIntroNav` |
| `app.js` | 装配：加载数据、绑定事件、权限、驱动渲染 | 无（自执行 `boot()`） |

依赖方向严格单向，共四层：

```
app.js → 渲染模块（render / detail / alert）+ 编辑器 editor → view.js → dom.js
         theme.js、api.js、digest.js 为叶子（不 import 任何模块）
         editor.js 额外依赖 vendor/codejar.js（vendored 的第三方源码）
```

- 渲染模块之间**互不依赖**（状态文案等公共部分统一放 `view.js`）；
- 只有被**两个及以上渲染模块**复用的构件才允许进 `view.js`，其余留在各自模块内；
- 不允许反向依赖与循环依赖（`app.js` 之外的模块不得回头依赖 `app.js`）。

---

## 7. 渲染流程

```
boot()
 ├─ cacheDom()            缓存固定节点
 ├─ buildAccentOptions()  由 ACCENTS 常量生成下拉选项
 ├─ theme.subscribe()     主题状态变化 -> 同步图标与无障碍标签
 ├─ theme.apply()         立即应用本地主题偏好
 ├─ bindEvents()          搜索、快捷键、主题、强调色、刷新、权限组件、新建命名空间、目录点击
 ├─ loadNav()             GET /api/nav（首屏唯一请求）
 └─ applyServerDefaults() 本地无偏好时采用服务端默认主题
```

关键实现约定：

- **单请求首屏**：`/api/nav` 一次性返回设置、权限、命名空间、服务与统计，不再有 `config → nav` 的串行等待。
- **模板克隆**：页面内用 `<template>` 声明 `tpl-namespace` / `tpl-service` / `tpl-detail` / `tpl-kv` / `tpl-empty` / `tpl-toast`，渲染模块统一经 `view.js` 的 `fromTemplate(id, rootSelector)` 拿到「待挂载片段 + 查询作用域」再填充文本。该重活集中在 `view.js`，各渲染模块不再各自 `cloneTemplate` + `querySelector`。
- **文本填充**：一律 `setText(node, value)`（内部为 `textContent`），从机制上杜绝 XSS。
- **显隐切换**：一律用 `toggleHidden(node, boolean)` / `isHidden(node)`，其内部操作 `hidden` **属性**（`setAttribute` / `removeAttribute`）。不要写 `node.hidden = false` —— `hidden` 是 `HTMLElement` 的 IDL 属性，`SVGElement`（例如模式图标 `<svg id="theme-icon-*">`）并未实现它，赋值只会挂一个普通 JS 属性，真正的 `hidden` 属性不会被移除，元素会一直被 `[hidden] { display: none }` 隐藏。
- **图标**：统一来自 lucide，开发期由 `npm run icons` 生成 `icons/sprite.svg`（约 4 KB），业务代码通过 `<use href="./icons/sprite.svg#名称">` 外链引用。颜色由 sprite 内的 `stroke="currentColor"` 跟随文字色，尺寸由 CSS `.icon` 控制。
- **目录树**：`namespace` 一级、`service` 二级；折叠通过 `.node--collapsed` 类切换（直接改类、不重渲染，保留滚动位置），箭头用**静态** `transform: rotate(90deg)` 表示展开。
- **目录行结构**：`.node__row` 是弹性行 = `.node__head`（展开开关，占满剩余宽度）+ `.node__add`（行尾的新增入口）。两者是**兄弟节点**，没有把按钮嵌进按钮。
- **名称截断**：服务名与命名空间名均 `text-overflow: ellipsis`，全名通过 `title` 属性作为 tooltip；状态信息额外写入 `aria-label` 供读屏使用。
- **标题单行截断**：站点标题（`.brand__title`）、服务标题（`.detail__title`）与说明侧栏条目（`.intro__item`）统一为 `white-space: nowrap` + `overflow: hidden` + `text-overflow: ellipsis` + `min-width: 0`（最后一项让元素能被压缩到容器宽度以内，否则长标题会撑破布局 —— 对 `.intro__item` 还意味着从 200px 侧栏横向溢出），完整文本由渲染层写入 `title` 属性。`data/section/service.json` 里的 `s-code-server` 就是这条规则的验证样例（名称刻意写得很长）；说明侧栏的条目名来自每篇文档 frontmatter 的 `label`（同样可能很长，服务端按 `order` 升序、过滤 `hidden` 后下发）。
  - 检查：`check-static` 断言这三个选择器必须同时具备上述四条声明（并钉住 `intro.js` 必须写入条目 `title`）；`check-render` 断言详情标题必须带 `title` 属性（截断后要看全名）。
- **未归属兜底**：服务的 `namespaceId` 找不到对应命名空间时，归入「未分组」条目渲染，不会静默丢失；该分组不是真实命名空间，因此**永远不出新增入口**。
- **空命名空间**：普通只读视图会跳过没有可见服务的命名空间（保持目录整洁）；**super 视图会保留它们** —— 否则新建的命名空间会立刻「消失」，无从往里添加服务（见 `tree::empty-namespace-*` 场景）。
- **详情行骨架**：`appendRow(list, key, value, context)` 只负责「key 纯文本 + 值插槽」，**值怎么显示**交给值渲染管道。
- **值渲染管道**（`detail.js`）：规则表 `RENDER_RULES` 自上而下匹配，第一条命中即生效，命中后交给对应的渲染函数加工；渲染函数签名统一为 `(node, value, context)`。

| 顺序 | 匹配条件 | 渲染函数 | 展示形式 | 组件类 |
| --- | --- | --- | --- | --- |
| 1 | `key === 'status'` | `valueStatus` | 色调块（颜色由 `data-status` 写入的 `--status-color` 驱动） | `.badge` `.badge--status` |
| 2 | `key === 'url'` | `valueLink` | 可点击链接（是否新开标签页由 `openInNewTab` 决定） | `.kv__link` |
| 3 | 空值（`''` / `null` / `undefined` / 空数组） | `valueMuted` | 灰字占位 `—` | `.kv__value--muted` |
| 4 | `object` 类型 | `valueJson` | 代码块形式的 JSON（`JSON.stringify(value, null, 2)`） | `.kv__code` |
| 5 | `slice`（数组）类型 | `valueChunks` | 每个元素一个 chunk 块（元素本身是容器时用紧凑 JSON，保证信息不丢） | `.kv__chunks` `.chunk` |
| 6 | 其余基本类型 | `valueText` | 常规文本；数字与布尔用等宽，避免与字符串混淆 | `.kv__value--mono` |

- 字段顺序为内置字段（`namespace` / `status` / `url` / `description` / `tags`）+ 自定义 `attributes` + `id`。
- `tags` 本身是数组，因此天然走第 5 条 chunk 规则，没有专门分支；`attributes` 的每个值可以任意 JSON 类型，全部由这张表决定形态。
- 第 6 条 `basic` 恒真，作为兜底，保证任何值都有确定展示。

> 新增一种展示形式 = 在 `RENDER_RULES` 里加一条规则 + 在 `components.css` 里加一个类；`appendRow` 与 `renderDetail` 都不用改。

**想一次看全所有形态**：打开 `值渲染样例`（`s-render-demo`，位于「工具」命名空间）—— 这条服务的属性刻意覆盖了上表每一行，包括空描述与空标签；`tests/fixtures/nav.json` 里的同名条目用于回归快照，并由 `check-render.mjs` 做覆盖自检（少一种形态即失败）。
- **空态**：`tpl-empty` 为「标题 + 提示」两行，两侧空态文案统一用英文。空态时容器分别带 `.detail--empty`（详情未选中服务）与 `.tree--empty`（目录无数据 / 无匹配），由 CSS 让整块在容器内居中；恢复内容后该类被移除。
  - 居中用 `margin: auto` 而非 `align-items` / `justify-content`：容器高度不足时后者会把内容挤到滚动条够不到的一侧。
  - 侧栏能居中是因为 `.sidebar` 是列向 flex、`.tree` 以 `flex: 1 1 auto` 占满剩余高度；`.tree` 既不自设高度也不接管滚动，长列表依旧在 `.sidebar` 上滚动。
- **权限组件**：显示 `level/role`，点击行为按当前级别分两种 ——
  - 当前为 `3`（user）：弹出居中密钥弹窗，输入后 Enter 提交。客户端先用 `digest.js` 把密钥算成 SHA-256 摘要，只把摘要发出去（`POST /api/permission`），通过后把**摘要**（不是明文）存入 `localStorage`（键 `index-srv:digest`）并重拉 `/api/nav`。
  - 当前为 `0`（super）：直接清掉本地摘要、重拉 `/api/nav`，即切回只读。
  - 服务端未配置 `INDEX_SRV_SECRET` 时不存在 super，点击只提示原因。
- **权限与写入口的联动**：`renderPermission()` 是同一条链上的开关 —— 它把 `[+]` 入口按 `superUser` 显隐，并把 `canEdit` 传给 `renderTree()`（目录树的入口与空命名空间策略都据此决定），因此**从 3 提升到 0 后目录树会整体重绘出写入口**，切回只读时又全部收起。
- **新建命名空间**：点侧栏头部的 `[+]` → 复用输入弹窗（模式 `namespace`，`type="text"` + `placeholder`）→ Enter 调 `POST /api/namespaces`（只传 `name`，`id` 与 `order` 由服务端生成）→ 成功后把该 id 从折叠集合中移除并**重拉 `/api/nav`**：新条目立即出现在列表里并保持展开，页脚的 `LAST MODIFY` 同步刷新成落盘时间。
- **添加服务**：点某命名空间行尾的 `[+]` → 打开**同一个**编辑器弹窗（样式与编辑完全一致，没有任何额外交互元素）：初始草稿由 `createDraft(namespaceId, state.nav.serviceSchema)` 生成 —— 骨架来自服务端的 `data/conf/service.schema.json`（启动时读入、随 `/api/nav` 下发），因此**加字段不用改代码**：在该文件里加一个键，新建草稿里就多一个占位。字段取值原则是类型零值：字符串 `''` / 数组 `[]` / 对象 `{}` / 数字 `0`；`status` 与 `enabled` 例外取模型默认值（`running` / `true`），因为它们的"零值"分别是「非法枚举」与「建出来就是隐藏的」。骨架不含 `id`（主键由服务端生成，想自定也可以写在模板里）与 `namespaceId`（归属是「点开的那个命名空间」这一上下文，由客户端注入，模板里写了也会被忽略）。拿不到下发模板时（例如连的是旧服务端）由 `editor.js` 的内置兜底顶上 —— 三处骨架必须字面一致，`check-static` 有漂移断言。
  - 保存前校验固有字段：`name` / `url` 必填（新建还需 `namespaceId`）→ `POST /api/sites` → 关弹窗 → **展开所属命名空间并选中新服务** → 重拉 `/api/nav`（目录、详情与页脚 `LAST MODIFY` 一并刷新）。
  - 草稿里模型之外的顶层字段会被服务端原样写进数据文件（面板不解析、不展示），因此新增字段无需改代码。
- **详情头部的两个图标入口**：打开服务地址（`external-link`，即结构图里的 `[->]`）与编辑服务（`pencil`，仅 super 可见）。两者**都只有图标、没有可见文本**，因此外观统一交给 `.icon-btn` 基类、尺寸在 `.detail__open, .detail__edit` 一处放大到 24px（比侧栏的紧凑按钮略大，与详情标题字号相称），含义由渲染层写入的 `title` / `aria-label` 给出（`打开服务 <名称>` / `编辑服务 <名称>`）。`check-static` 断言两者尺寸一致且都带 `.icon-btn`，`check-render` 断言它们都带 `title` 与 `aria-label`。
- **编辑服务**：点详情面板头部的编辑按钮 → 打开 JSON 编辑器，初始内容是该服务的**完整记录**（与 `/api/nav` 下发的字段一致）。
  - 编辑器由 `editor.js` 挂载 CodeJar（`vendor/codejar.js`，`npm run vendor` 生成），高亮用自己的最小 JSON 词法（`json-key` / `json-string` / `json-number` / `json-literal` / `json-punct`），不引入 Prism 之类的额外依赖；重绘用 DOM 节点而不是 `innerHTML`。
  - 保存前先跑 `validateDraft()`：JSON 必须可解析、顶层必须是对象、`id` 不得改动、`name` 与 `url` 必填且合法；不通过就留在弹窗里把原因写进状态行。
  - 通过后 `PUT /api/sites/:id`（局部更新语义，编辑器提交的是整份记录）→ 关弹窗 →**重拉 `/api/nav`**：目录计数、详情内容与页脚 `LAST MODIFY` 一并刷新。
  - 头部右侧是**图标按钮**：重置（`rotate-ccw`）、取消（`x`）与保存（`check`）—— 与页面其它操作入口一样用 `.icon-btn`，靠 `title` / `aria-label` 标明含义。
  - **重置**：点重置按钮把编辑区还原成打开弹窗时的内容（编辑模式 = 该服务的原记录，新建模式 = `createDraft()` 的骨架），**点击即生效、不做二次确认**；它只改编辑区 —— 既不写盘，也不会绕过保存前的校验。初始内容由编辑器实例自己记着（`editor.js` 的 `load()` 记下、`reset()` 回到它），所以「重置 = 回到打开时的内容」由模块保证，`app.js` 不必另存一份副本。
  - **状态行的两种提示**：点击类反馈（重置）走 `setTransientEditorStatus()`，显示「已重置为初始内容」后**两秒自动换回操作提示** —— 状态行常驻在弹窗里，一句「已完成」留在上面会让人以为弹窗卡住；校验/写入失败则保持常驻，因为它是待处理的，要留到用户动手或关窗。状态行只有 `setEditorStatus()` 一个写入入口，它每次都会作废尚未到点的定时器，避免旧提示稍后冒出来盖住刚写的错误信息（`check-static` 对这两条都有断言）。
  - 快捷键：`Ctrl / ⌘ + Enter` 保存、`Esc` 取消；点击遮罩同样关闭。权限切回只读时编辑器会自动收起。
- **输入弹窗**（`.modal` + `.input--modal`）：全屏遮罩 + 一个居中输入框，同一弹窗承担两种用途 ——
  - `secret`（提升权限）：`type="password"`，**不含任何可见文本**（无标题、无占位符、无按钮；`aria-label` 仅供读屏）。
  - `namespace`（新建命名空间）：`type="text"`，带 `placeholder="namespace name"`，写明要输入什么。
  - 两种用途都由 `submitModal()` 按 `modalMode` 分派；Enter 提交、`Esc` 或点击遮罩关闭；`aria-expanded` 会归还给当次打开它的触发元素。因项目约定不引入动效，弹窗为瞬时出现。

### 搜索与快捷键

| 交互 | 行为 |
| --- | --- |
| 输入关键字 | 匹配服务 `name` / `description` / `url` / `status` / `tags` / `attributes` 的键与值；命中命名空间名时展示该命名空间全部服务；输入经 120ms 防抖 |
| 搜索中 | 强制展开所有命中命名空间，便于直接看到结果 |
| `/` | 聚焦搜索框（输入态下不劫持） |
| `Esc` | 输入弹窗展开时先收起弹窗；否则清空搜索并重渲染 |
| 刷新按钮 | 重新拉取 `/api/nav` |

---

## 8. 扩展指南

### 新增一个图标

1. 在 [lucide.dev/icons](https://lucide.dev/icons) 选定图标，记下 kebab-case 名称（如 `settings`）。
2. 把名称加入 `scripts/build-icons.mjs` 的 `MANIFEST` 数组。
3. 执行 `npm run icons` 重新生成 `src/web/icons/sprite.svg`，产物需一并提交（首次执行前需 `npm install`）。
4. 在 HTML/JS 中引用：`<use href="./icons/sprite.svg#settings">`，尺寸与颜色交给 CSS，不要在 sprite 或页面里写死 `width` / `fill`。

### 新增服务字段（例如把 `icon` 渲染出来）

1. 数据层：确认字段已由 API 返回（必要时在 `src/core/store.js` 的 `normalizeSite` 中补规范化）。
2. 展示位置：目录树在 `render.js` 的 `createService()`；详情在 `detail.js` —— 先用 `appendRow(list, key, value, context)` 挂成一行，展示形式由值渲染管道按值类型自动决定；若该字段需要特殊形态（像 `status` / `url` 那样），在 `RENDER_RULES` 里加一条 key 规则即可。
3. 模板：目录树改 `tpl-service`，详情无需新增模板（key: value 由 `tpl-kv` 生成）。
4. 样式：在 `components.css` 中新增规则，颜色只取令牌。
5. 若字段可被搜索命中，同步更新 `render.js` 与 `src/api/sites.js` 中的关键字匹配逻辑。

> 说明：`site.icon` 目前只在数据模型与 API 中保留，界面尚未渲染，属于预留字段。

### 新增一个组件

1. 在 `index.html` 用语义标签声明结构（如需动态重复，同时写 `<template>`）。
2. 在 `components.css` 追加 `.block` / `.block__element` 规则，颜色只取令牌。
3. 若需要状态切换，用修饰符类（如 `.node--collapsed`）或 `data-*` 属性 + CSS 变量，而不是内联样式。
4. 若该构件会被多个渲染模块复用，把「取模板 + 填充」的部分放进 `view.js`，不要在模块间复制。

### 新增一个页面级模块

在 `js/` 下新增模块，通过 `import` 接入 `app.js`（参考 `detail.js` 的粒度：一个模块只负责一块输出）。模块内不要直接操作 `window` 全局，需要依赖时由 `app.js` 注入。依赖只能向下（渲染模块 → `view.js` → `dom.js`），不得横向引用其它渲染模块。

---

## 9. 约束清单（改动前请确认）

- [ ] 运行期未引入 npm 包与前端框架（devDependencies 仅 `lucide-static`，仅供生成图标）
- [ ] HTML 中没有 `<style>`、`style=""`、`onclick=""`
- [ ] CSS 中没有 `transition` / `animation` / `@keyframes`
- [ ] 圆角一律为 `var(--radius)`（值为 0）
- [ ] 颜色与间距取自 `theme.css` 令牌，未硬编码；状态色使用 `--status-*` 令牌
- [ ] 动态文本经 `textContent` 写入
- [ ] 新增令牌时补齐暗色取值
- [ ] 图标经 `icons/sprite.svg` 引用，未手写 SVG 路径、未使用图标 CDN
- [ ] 增改图标后已执行 `npm run icons` 并提交生成的 sprite
- [ ] 显隐切换使用 `toggleHidden()` / `isHidden()`，未直接赋值 `.hidden`（SVG 元素不支持该 IDL 属性）
- [ ] 三段式布局的宽度约束仍由 `.shell`（80%）承担，未在组件内写死宽度
- [ ] 已执行 `npm test`（含渲染快照对比）；若界面变化是本次改动的预期结果，用 `npm run test:update` 刷新基线并审阅 diff
- [ ] 属性值的展示一律经 `RENDER_RULES` 管道，未在 `renderDetail()` 里手写类型分支
- [ ] 密钥弹窗内没有可见文本（仅 `aria-label`）；明文密钥不落任何存储，只保存 SHA-256 摘要
- [ ] 涉及视觉/布局的改动已**人工验收**：当前环境无浏览器内核，自动化只能覆盖 DOM 结构与文案，真实渲染与观感必须在浏览器里确认（见 [arch.md](arch.md#9-回归套件) §9.1）

---

## 10. 兼容性与可访问性

- 目标浏览器：支持 ES Module 与 CSS 自定义属性的现代浏览器（Chrome/Edge 90+、Firefox 90+、Safari 15+）。
- 依赖的现代 API：`fetch`、`matchMedia`、`URLSearchParams`、`<template>`、`localStorage`、`CSS.escape`。
- **密钥摘要依赖 Web Crypto（`crypto.subtle`）**：浏览器只在安全上下文（`https` 或 `localhost`）提供它。通过局域网明文 HTTP 访问时该 API 不可用，此时点击权限组件会提示改用 https 或 localhost —— 这是浏览器的既定限制，不是实现缺陷。
- 图标引用：外链 `<use href="./icons/sprite.svg#名称">` 依赖浏览器对「外部 SVG 片段引用」的支持，上述目标浏览器均已支持；sprite 与页面同源（同域静态资源），无需 CORS。
- 可访问性：图标按钮提供 `aria-label` 与 `.sr-only` 文本；目录树 `aria-expanded` 反映折叠状态；服务项 `aria-label` 附带状态文案（避免只用颜色传达信息）；详情面板 `aria-live="polite"`；`:focus-visible` 统一使用 `--ring` 作为焦点环。
- 响应式：`900px` 以下主体改为上下堆叠、工具栏换行并让搜索框占满整行。

---

## 11. 本地调试

无需构建步骤，直接启动服务后修改文件、刷新浏览器即可：

```bash
npm start                     # 默认 http://127.0.0.1:8080
npm run dev                   # 服务端热重启（--watch），前端仍为刷新即生效
npm run icons                 # 仅在增改图标时需要（读取 node_modules/lucide-static）
npm test                      # 回归套件：静态契约 + 纯逻辑 + 渲染快照 + 文档 + 端到端冒烟
npm run test:update           # 有意改变界面后刷新渲染基线
```

改完前端建议跑一次 `npm test`：其中的渲染快照会拿 `render.js` / `detail.js` 的结构与文案和基线逐字节比对，漏挂节点、类名写错、条件分支走反都会当场暴露（细节见 [arch.md](arch.md#9-回归套件)）。

> **视觉部分需人工验收**：当前环境没有任何浏览器内核，自动化只能覆盖 DOM 结构与文案，真实渲染、布局、配色观感与响应式表现请在浏览器里确认。原因、覆盖边界与恢复自动化的方式见 [arch.md](arch.md#9-回归套件) §9.1。

> 只是运行或部署服务**不需要** `npm install`：图标产物 `icons/sprite.svg` 已提交到仓库，运行时没有任何 npm 依赖。

静态资源默认 `cache-control: no-cache` 并带 ETag，浏览器每次会发协商请求，不会读到旧文件。若希望生产环境启用强缓存，设置 `web.cacheMaxAge`（秒）或环境变量 `INDEX_SRV_WEB_CACHE`。
