/**
 * 轻量日志器：stdout 输出人类可读文本，文件输出 JSON Lines（便于采集）。
 * 文件按天切分：data/log/app-YYYY-MM-DD.log、data/log/access-YYYY-MM-DD.log
 */
import fs from 'node:fs';
import path from 'node:path';

const LEVEL_WEIGHT = { debug: 10, info: 20, warn: 30, error: 40 };

function todayKey(date = new Date()) {
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function formatText(record) {
  const { time, level, message, ...rest } = record;
  const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  return `[${time}] ${level.toUpperCase().padEnd(5)} ${message}${extra}`;
}

export function createLogger({ level = 'info', logDir = null, toStdout = true, toFile = true } = {}) {
  const threshold = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info;
  const fileEnabled = Boolean(toFile && logDir);
  const streams = new Map();
  let currentDay = todayKey();

  if (fileEnabled) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  function streamFor(category) {
    const day = todayKey();
    if (day !== currentDay) {
      for (const stream of streams.values()) stream.end();
      streams.clear();
      currentDay = day;
    }
    const key = `${category}-${day}`;
    let stream = streams.get(key);
    if (!stream) {
      stream = fs.createWriteStream(path.join(logDir, `${category}-${day}.log`), { flags: 'a' });
      stream.on('error', () => {
        /* 日志写入失败不应影响服务 */
      });
      streams.set(key, stream);
    }
    return stream;
  }

  function write(category, levelName, message, fields) {
    const record = { time: new Date().toISOString(), level: levelName, message, ...(fields ?? {}) };
    if (toStdout && LEVEL_WEIGHT[levelName] >= threshold) {
      const line = formatText(record);
      if (levelName === 'error') process.stderr.write(`${line}\n`);
      else process.stdout.write(`${line}\n`);
    }
    if (fileEnabled) streamFor(category).write(`${JSON.stringify(record)}\n`);
  }

  return {
    level,
    debug: (message, fields) => write('app', 'debug', message, fields),
    info: (message, fields) => write('app', 'info', message, fields),
    warn: (message, fields) => write('app', 'warn', message, fields),
    error: (message, fields) => write('app', 'error', message, fields),
    /**
     * 访问日志：始终落盘，仅在 debug 级别时同时打印到 stdout。
     */
    access(record) {
      if (fileEnabled) streamFor('access').write(`${JSON.stringify(record)}\n`);
      if (toStdout && threshold <= LEVEL_WEIGHT.debug) {
        process.stdout.write(`${formatText({ ...record, level: 'access', message: record.message ?? 'request' })}\n`);
      }
    },
    close() {
      for (const stream of streams.values()) stream.end();
      streams.clear();
    },
  };
}
