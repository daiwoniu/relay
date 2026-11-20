import type { WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import { responsibilityClassificationNotice } from './workspace-console-view-model.ts';

export default function WorkspaceResponsibilityNotice({ responsibility }: {
  responsibility: Pick<WorkspaceConsoleResponsibilityDto, 'complete' | 'unverifiedCount'> & Partial<Pick<WorkspaceConsoleResponsibilityDto,'relationCoverage'>> | null;
}) {
  const notice = responsibilityClassificationNotice(responsibility);
  const relation = responsibility && responsibility.relationCoverage !== 'complete' ? '部分飞书关联尚未核实；未显示的关联项不代表不存在。' : null;
  return notice || relation ? <p role="status" className="rounded-lg border border-amber-400/25 bg-amber-950/25 px-3 py-2 text-sm">{[notice,relation].filter(Boolean).join(' ')}</p> : null;
}
