const count = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
export const feishuContextLabels = { carry: '新建并带上摘要', clear: '从空白开始' } as const;

export function formatCompactTokens(value: number): string {
  if (value < 1_000) return count.format(value);
  const thousands = value / 1_000;
  // Promote values whose rounded display would otherwise reach 1,000K.
  if (Math.round(thousands * 100) / 100 >= 1_000) return `${count.format(value / 1_000_000)}M`;
  return `${count.format(thousands)}K`;
}
