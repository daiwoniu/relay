import { resolveCodexFileReferencePathResult } from './codex-file-directives.ts';

interface PreviewProjectContext {
  activeSessionId: string | null;
  currentProjectId: string | null;
  sessions: readonly { id: string; project_id: string | null }[];
  projects: readonly { id: string; path: string }[];
}

export function resolveFilePreviewPath(filePath: string, context: PreviewProjectContext, projectPath?: string) {
  const projectId = context.activeSessionId
    ? context.sessions.find((session) => session.id === context.activeSessionId)?.project_id
    : context.currentProjectId;
  const root = projectPath ?? context.projects.find((project) => project.id === projectId)?.path;
  return resolveCodexFileReferencePathResult(filePath, root);
}
