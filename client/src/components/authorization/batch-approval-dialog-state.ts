export interface BatchApprovalDialogStateInput {
  action: 'accept';
  status: 'confirming' | 'submitting' | 'complete';
  requestCount: number;
  processed?: number;
  success?: number;
  skipped?: number;
  failed?: number;
}

export type BatchApprovalDialogTone = 'accept' | 'success' | 'partial';

export interface BatchApprovalDialogPresentation {
  tone: BatchApprovalDialogTone;
  icon: 'accept' | 'warning';
  eyebrow: string;
  title: string;
  description: string;
  impact: string;
  confirmLabel: string;
}

export function getBatchApprovalDialogPresentation(input: BatchApprovalDialogStateInput): BatchApprovalDialogPresentation {
  const verb = '通过';
  const actionTone = 'accept';
  const processed = input.processed || 0;
  const success = input.success || 0;
  const skipped = input.skipped || 0;
  const failed = input.failed || 0;

  if (input.status === 'complete') {
    const partial = skipped > 0 || failed > 0;
    return {
      tone: partial ? 'partial' : 'success',
      icon: partial ? 'warning' : 'accept',
      eyebrow: partial ? '部分请求未完成' : '批量处理完成',
      title: partial ? `批量${verb}部分完成` : `批量${verb}完成`,
      description: `成功 ${success} 项，已失效 ${skipped} 项，失败 ${failed} 项。`,
      impact: partial ? '请检查未完成的请求' : '全部请求均已处理成功',
      confirmLabel: '',
    };
  }

  if (input.status === 'submitting') {
    return {
      tone: actionTone,
      icon: 'accept',
      eyebrow: '正在逐项处理',
      title: `正在批量${verb}`,
      description: `已处理 ${processed} / ${input.requestCount} 项。处理完成前请保持此窗口打开。`,
      impact: `正在处理 ${input.requestCount} 项请求`,
      confirmLabel: '',
    };
  }

  return {
    tone: actionTone,
    icon: 'accept',
    eyebrow: '批量操作审阅',
    title: `批量${verb}请求`,
    description: '本批次已冻结，弹出后新增的授权不会加入。确认后将按当前顺序逐项提交。',
    impact: `此操作将影响 ${input.requestCount} 项请求`,
    confirmLabel: `${verb} ${input.requestCount} 项请求`,
  };
}
