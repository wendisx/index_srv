/**
 * 说明文档接口：列表 + 单篇内容。
 *
 * 文档来源由 `storage.introPath` 配置（相对 dataDir 解析），可以是**目录**也可以是**单文件**：
 *   - 目录  → 列出其中所有 `.md`（前端渲染为 sidebar + content）
 *   - 文件  → 只有一篇（前端只渲染 content）
 *   - 缺失  → mode 为 none，前端隐藏入口（不留一个点了没反应的按钮）
 *
 * 接口返回剥掉 frontmatter 后的 Markdown 原文（frontmatter 只用来控制侧栏，不属于正文），
 * 渲染交给前端的 marked —— 服务端不碰 HTML，也就不需要在服务端引入任何解析/清洗依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { notFound, validationError } from '../core/errors.js';
import { ok } from '../core/http.js';

/** 文件名白名单：不允许分隔符与控制字符，从源头挡掉 ../ 与绝对路径 */
const SAFE_ID = /^[\w.-]+\.md$/;

/**
 * 解析每个 .md 开头的 frontmatter（`---` 包围的 YAML 子集）。
 * 侧栏的名称 / 顺序 / 显隐全由这里的三个字段控制，正文不再参与：
 *   label  → 侧栏展示名（缺省回落：去掉扩展名与序号前缀的文件名）
 *   order  → 升序排序（缺省排最后，同序按文件名）
 *   hidden → true 时不进入侧栏（单篇内容接口仍可访问）
 * 刻意不做完整 YAML 解析：三个标量字段逐行读 `key: value` 就够了，不值得引依赖。
 * 没有 frontmatter 或块内写法不对时按全部缺省处理 —— 接口不能因一篇坏文档挂掉。
 */
function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { fields: {}, body: content.replace(/^\r?\n+/, '') };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const entry = /^([\w-]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (entry) fields[entry[1]] = entry[2];
  }
  return { fields, body: content.slice(match[0].length).replace(/^\r?\n+/, '') };
}

/** 把 frontmatter 的原始字符串归一化成三个字段（写法不对的一律按缺省处理） */
function metaOf(fields) {
  return {
    label: (fields.label ?? '').replace(/^(['"])(.*)\1$/, '$2').trim(),
    order: /^-?\d+$/.test(fields.order ?? '') ? Number(fields.order) : Number.MAX_SAFE_INTEGER,
    hidden: (fields.hidden ?? '').trim().toLowerCase() === 'true',
  };
}

/** 把 .md 文件名变成展示名：去掉扩展名与可能的前导序号（01-xxx → xxx） */
const displayName = (file) => file.replace(/\.md$/i, '').replace(/^\d+[-_.]/, '');

/**
 * 探测说明文档形态：dir / file / none。
 * 只在请求时探测（而不是启动时固定），这样运维新建/改动目录后不必重启。
 */
function introMode(introPath) {
  try {
    const stat = fs.statSync(introPath);
    if (stat.isDirectory()) return 'dir';
    if (stat.isFile() && introPath.toLowerCase().endsWith('.md')) return 'file';
    return 'none';
  } catch {
    return 'none';
  }
}

export function registerIntroRoutes(router) {
  router.get('/api/intro', ({ res, config }) => {
    const introPath = config.storage.introPath;
    const mode = introMode(introPath);

    if (mode === 'none') {
      ok(res, { mode, items: [] });
      return;
    }
    const root = mode === 'dir' ? introPath : path.dirname(introPath);
    const files =
      mode === 'dir'
        ? fs.readdirSync(root).filter((file) => file.toLowerCase().endsWith('.md'))
        : [path.basename(introPath)];

    // 列表里就带上展示名（frontmatter 的 label），前端不必为拿标题多发请求；
    // 侧栏的顺序与显隐同样由 frontmatter 在这里定稿：order 升序（缺省排最后，
    // 同序按文件名）、hidden 的不出现 —— 前端拿到即用，不需要也不应该再排序或过滤
    const items = files
      .map((file) => {
        const fallback = displayName(file);
        try {
          const { fields } = parseFrontmatter(fs.readFileSync(path.join(root, file), 'utf8').slice(0, 4096));
          return { file, ...metaOf(fields), fallback };
        } catch {
          return { file, label: '', order: Number.MAX_SAFE_INTEGER, hidden: false, fallback };
        }
      })
      .filter((item) => !item.hidden)
      .sort((a, b) => a.order - b.order || a.file.localeCompare(b.file, 'zh-CN'))
      .map(({ file, label, fallback }) => ({ id: file, name: label || fallback }));

    ok(res, { mode, items });
  });

  router.get('/api/intro/:id', ({ res, config, params }) => {
    const introPath = config.storage.introPath;
    const mode = introMode(introPath);
    if (mode === 'none') throw notFound('说明文档未配置');

    const id = params.id ?? '';
    if (!SAFE_ID.test(id)) {
      throw validationError('文档名只允许字母、数字、下划线、点、连字符，且必须是 .md');
    }

    // 单文件模式下只认这一个名字；目录模式下解析后必须仍落在目录内（双重保险）
    const root = mode === 'dir' ? introPath : path.dirname(introPath);
    if (mode === 'file' && id !== path.basename(introPath)) throw notFound(`说明文档 ${id} 不存在`);

    const target = path.resolve(root, id);
    if (target !== path.join(root, path.basename(target)) || !fs.existsSync(target)) {
      throw notFound(`说明文档 ${id} 不存在`);
    }

    let raw;
    try {
      raw = fs.readFileSync(target, 'utf8');
    } catch {
      throw notFound(`说明文档 ${id} 不可读`);
    }

    // frontmatter 只用来控制侧栏，不属于正文 —— 剥掉再发
    const { fields, body } = parseFrontmatter(raw);
    const { label } = metaOf(fields);

    ok(res, { id, name: label || displayName(id), content: body });
  });
}
