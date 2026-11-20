import fs from 'node:fs';

// Parse each file before merging; validation of effective values belongs to the domain.
export function parseKvConfig(content, { allowedKeys, source = '配置' } = {}) {
  const values = new Map();
  for (const [index, rawLine] of String(content).split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`${source} 第 ${index + 1} 行格式无效，应使用 KEY=VALUE`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*(?:\.[a-zA-Z0-9_-]+)?$/.test(key)) throw new Error(`${source} 第 ${index + 1} 行配置键格式无效`);
    if (allowedKeys && !allowedKeys.has(key)) throw new Error(`${source}：未知配置项：${key}`);
    if (values.has(key)) throw new Error(`${source}：重复配置项：${key}`);
    let value = line.slice(separator + 1).trim();
    if (value.length >= 2 && value[0] === value.at(-1) && ['"', "'"].includes(value[0])) value = value.slice(1, -1);
    values.set(key, value);
  }
  return values;
}

export function loadKvConfig(filePath, { allowedKeys, required = false } = {}) {
  if (!filePath.endsWith('.conf') || filePath.endsWith('.local.conf')) throw new Error('配置入口必须是基础 .conf 路径');
  const localPath = filePath.slice(0, -5) + '.local.conf';
  const values = new Map();
  const sources = new Map();
  let found = false;
  for (const source of [filePath, localPath]) {
    let content;
    try { content = fs.readFileSync(source, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`无法读取配置文件：${source}`, { cause: error });
    }
    found = true;
    for (const [key, value] of parseKvConfig(content, { allowedKeys, source })) {
      values.set(key, value);
      sources.set(key, source);
    }
  }
  if (!found && required) throw new Error(`配置文件不存在：${filePath} 或 ${localPath}`);
  return found ? { values, sources } : null;
}
