export function readFeishuExecutionLine(line?: string) {
  // Older stored replies include this human-readable footer. A model label can contain the separator.
  const fields = line?.match(/^引擎：(.+?) · 模型：(.+) · 强度：(.+?) · 速度：(.+?) · 压缩次数：(\d+|不适用)$/);
  if (!fields) return null;
  const [, engine, model, effort, speed, compactions] = fields;
  return {
    engine, model,
    effort: effort === '未提供' ? null : effort,
    speed: speed === '未提供' ? null : speed,
    compactions: compactions === '不适用' ? null : compactions,
  };
}
