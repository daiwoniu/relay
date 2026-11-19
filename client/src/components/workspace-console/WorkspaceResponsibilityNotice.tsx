import type { WorkspaceConsoleResponsibilityDto } from '../../generated/relay-contracts';
import { responsibilityClassificationNotice } from './workspace-console-view-model.ts';

export default function WorkspaceResponsibilityNotice({ responsibility }: {
  responsibility: Pick<WorkspaceConsoleResponsibilityDto, 'complete' | 'unverifiedCount'> | null;
}) {
  const notice = responsibilityClassificationNotice(responsibility);
  return notice ? <p role="status" className="rounded-lg border border-amber-400/25 bg-amber-950/25 px-3 py-2 text-sm">{notice}</p> : null;
}
