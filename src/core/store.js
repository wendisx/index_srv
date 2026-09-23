/**
 * 数据存储：把面板数据按语义拆成多份可独立编辑的 JSON 文件。
 *
 *   conf/settings.json      面板设置（配置类）
 *   section/namespace.json  命名空间
 *   section/service.json    服务
 *
 * 加载：启动时逐份读入 → 归一化 → 汇总为一份内存数据，并建立 id 索引（定位 O(1)）。
 * 写回：写操作不频繁，因此不做增量维护 —— 每次写事务结束后重新计算各分区内容，
 *       只把「内容确实变了」的分区落盘：未变化的分区不写文件、也不刷新 updatedAt。
 *       每份文件仍用「临时文件 + rename」原子替换。
 * 迁移：只有旧版单文件（conf/sites.json）时自动拆分为上面三份；旧文件原样保留，
 *       确认无误后可自行删除。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  SCHEMA_VERSION,
  combineSections,
  countInIndex,
  createIndex,
  normalizeNamespace,
  normalizeSettings,
  normalizeSite,
} from './schema.js';

/**
 * 分区声明表：文件位置、载荷键名、归一化方式集中在此 ——
 * 加载、迁移、写回都由这张表驱动，新增一个分区只需加一行。
 *
 * `name` 同时是内存数据里的字段名（settings / namespaces / sites），
 * `payloadKey` 是文件里的键名（文件用「服务」语义，内存与接口沿用 sites）。
 */
const SECTIONS = [
  {
    name: 'settings',
    dir: 'conf',
    file: 'settings.json',
    payloadKey: 'settings',
    legacyKeys: ['settings'],
    normalize: (raw) => normalizeSettings(raw ?? {}),
  },
  {
    name: 'namespaces',
    dir: 'section',
    file: 'namespace.json',
    payloadKey: 'namespaces',
    legacyKeys: ['namespaces', 'groups'],
    normalize: (raw) => asArray(raw).map(normalizeNamespace),
  },
  {
    name: 'sites',
    dir: 'section',
    file: 'service.json',
    payloadKey: 'services',
    legacyKeys: ['sites'],
    normalize: (raw) => asArray(raw).map(normalizeSite),
  },
];

const asArray = (raw) => (Array.isArray(raw) ? raw : []);
const asTimestamp = (value) => (typeof value === 'string' && value ? value : null);

/** 从载荷里按候选键取第一个存在的值（旧版单文件的键名与新分区不同） */
function readKey(payload, keys) {
  if (!payload || typeof payload !== 'object') return undefined;
  for (const key of keys) {
    if (payload[key] !== undefined) return payload[key];
  }
  return undefined;
}

/** 单条记录的副本：索引里的对象是内存态，不能让调用方直接改到 */
function cloneRecord(record) {
  return record === undefined ? undefined : structuredClone(record);
}

export class Store {
  #dirs;
  #legacyFile;
  #logger;
  #sections = new Map();
  #data = null;
  #index = null;
  #queue = Promise.resolve();

  /**
   * @param {object} options
   * @param {{conf: string, section: string}} options.dirs 两个分区目录的绝对路径
   * @param {string|null} [options.legacyFile] 旧版单文件绝对路径，仅作一次性迁移来源
   * @param {object|null} [options.logger]
   */
  constructor({ dirs, legacyFile = null, logger = null }) {
    this.#dirs = dirs;
    this.#legacyFile = legacyFile;
    this.#logger = logger;
  }

  /** 各分区文件的绝对路径（启动日志与 /api/config 展示用） */
  get files() {
    return Object.fromEntries([...this.#sections].map(([name, section]) => [name, section.file]));
  }

  async init() {
    for (const dir of new Set(SECTIONS.map((def) => this.#dirs[def.dir]))) {
      await fs.mkdir(dir, { recursive: true });
    }

    const loaded = [];
    for (const def of SECTIONS) {
      const payload = await this.#readFile(def);
      // 判定依据是「文件里有没有声明这个分区」，而不是文件本身在不在：
      // 空壳文件（{}）与缺失文件一样，都应交由旧版单文件兜底
      loaded.push({ def, file: this.#file(def), payload, provided: readKey(payload, [def.payloadKey]) !== undefined });
    }

    // 只有确有分区未提供时才去读旧版单文件：避免旧文件损坏拖垮已经完成迁移的部署
    const legacy = loaded.some((item) => !item.provided) ? await this.#readLegacy() : null;

    for (const { def, file, payload, provided } of loaded) {
      const source = provided ? payload : legacy;
      const value = def.normalize(readKey(source, provided ? [def.payloadKey] : def.legacyKeys));
      this.#sections.set(def.name, {
        def,
        file,
        value,
        // 分区文件确实提供了内容才算「已落盘」；其余（新建 / 迁移）留给首次写回
        written: provided,
        updatedAt: asTimestamp(source?.updatedAt),
      });
    }

    this.#data = combineSections(this.#parts());
    this.#index = createIndex(this.#data);
    const written = await this.#flush();

    if (written.length) {
      this.#logger?.info(legacy ? '数据已从旧版单文件迁移到分区文件' : '数据文件已就绪', {
        files: written.map((section) => section.file),
        legacy: legacy ? this.#legacyFile : undefined,
      });
    }
    return this.#data;
  }

  /** 只读快照（深拷贝，调用方可安全持有） */
  snapshot() {
    return structuredClone(this.#requireData());
  }

  /** 按 id 定位服务（索引 O(1)），返回副本；不存在时返回 undefined */
  siteById(id) {
    return cloneRecord(this.#requireIndex().sitesById.get(id));
  }

  /** 按 id 定位命名空间（索引 O(1)），返回副本；不存在时返回 undefined */
  namespaceById(id) {
    return cloneRecord(this.#requireIndex().namespacesById.get(id));
  }

  /** 命名空间下的服务数（索引 O(1)） */
  countSitesOf(namespaceId) {
    return countInIndex(this.#requireIndex(), namespaceId);
  }

  /**
   * 串行化的写事务：`mutator(草稿, 索引)` 直接修改草稿并返回结果。
   *
   * 传入的索引基于**草稿**构建（与草稿里的对象一一对应），用于 O(1) 定位；
   * 增删了数组元素之后它会失效，因此 mutator 内请「先定位、后增删」。
   * 单次事务失败不会阻断后续事务，内存数据也不会被改动。
   */
  async update(mutator) {
    const run = async () => {
      const draft = this.snapshot();
      const result = await mutator(draft, createIndex(draft));
      await this.#commit(draft);
      return result;
    };

    const next = this.#queue.then(run, run);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * 整体替换（导入备份用）。
   * 语义：仅在请求体中出现该字段时才替换，未出现则保留原值，
   * 避免「只导入某一部分」之类的不完整载荷把其它数据清空。
   */
  async replace(next) {
    return this.update((draft) => {
      if (next.settings !== undefined) draft.settings = next.settings;
      // 兼容 v1 备份中的 groups 键
      const namespaces = next.namespaces !== undefined ? next.namespaces : next.groups;
      if (namespaces !== undefined) draft.namespaces = namespaces;
      if (next.sites !== undefined) draft.sites = next.sites;
      return null;
    });
  }

  /** 提交草稿：汇总为内存数据（含归属回落）→ 重建索引 → 按分区差异写回 */
  async #commit(draft) {
    this.#data = combineSections({
      settings: draft.settings,
      namespaces: draft.namespaces,
      sites: draft.sites,
    });
    this.#index = createIndex(this.#data);
    await this.#flush();
  }

  /**
   * 写回：逐分区比对内存数据与已落盘内容，只写有变化的分区。
   * 未变化的分区既不产生文件写入，也不刷新自己的 updatedAt。
   */
  async #flush() {
    const written = [];

    for (const section of this.#sections.values()) {
      const value = this.#data[section.def.name];
      const firstWrite = !section.written;
      if (!firstWrite && JSON.stringify(value) === JSON.stringify(section.value)) continue;

      // 首次落盘沿用来源文件的时间戳：迁移只是换了存放形式，语义没有变
      if (section.written || !section.updatedAt) section.updatedAt = new Date().toISOString();
      section.value = value;
      section.written = true;
      await this.#writeSection(section);
      written.push({ section: section.def.name, file: section.file });
    }

    // 聚合时间戳 = 各分区里最新的修改时间（动态计算，不额外维护）
    this.#data.updatedAt = this.#latestTime();
    return written;
  }

  /** 各分区里最新的修改时间 */
  #latestTime() {
    const times = [...this.#sections.values()]
      .map((section) => section.updatedAt)
      .filter(Boolean)
      .sort();
    return times.at(-1) ?? new Date().toISOString();
  }

  /** 分区名 → 内存数据里的对应部分 */
  #parts() {
    return Object.fromEntries([...this.#sections].map(([name, section]) => [name, section.value]));
  }

  async #writeSection(section) {
    const payload = {
      version: SCHEMA_VERSION,
      updatedAt: section.updatedAt,
      [section.def.payloadKey]: section.value,
    };
    const tmp = `${section.file}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, section.file);
  }

  /** 读取一份分区文件；不存在返回 null，内容损坏则抛出（启动即失败，不留半可用状态） */
  async #readFile(def) {
    const file = this.#file(def);
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`无法加载数据文件 ${file}: ${error.message}`);
    }
  }

  /** 旧版单文件（conf/sites.json），仅在分区文件缺失时作为迁移来源读取 */
  async #readLegacy() {
    if (!this.#legacyFile) return null;
    try {
      return JSON.parse(await fs.readFile(this.#legacyFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error(`无法加载旧版数据文件 ${this.#legacyFile}: ${error.message}`);
    }
  }

  #file(def) {
    return path.join(this.#dirs[def.dir], def.file);
  }

  #requireData() {
    if (!this.#data) throw new Error('Store 尚未初始化');
    return this.#data;
  }

  #requireIndex() {
    if (!this.#index) throw new Error('Store 尚未初始化');
    return this.#index;
  }
}
