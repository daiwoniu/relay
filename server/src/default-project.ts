import fs from 'node:fs';
import path from 'node:path';
import type { Project } from './db/queries.js';

export const DEFAULT_PROJECT_NAME = 'Relay 默认项目';
const LEGACY_DEFAULT_PROJECT_NAMES = new Set(['Relay 工作区']);

export interface DefaultProjectRepository {
  createProject(name: string, projectPath: string, isSystem?: boolean, ownerUserId?: string | null): Project;
  getProjectByPath(projectPath: string): Project | undefined;
  getProjectByPathForOwner?(projectPath: string, ownerUserId: string): Project | undefined;
  updateProject(id: string, updates: Partial<Pick<Project, 'name' | 'pinned' | 'is_system'>>): void;
  migrateDefaultProject(id: string, projectPath: string, name: string, duplicateProjectId?: string): void;
}

export interface DefaultProjectResult {
  action: 'created' | 'migrated' | 'updated' | 'unchanged';
  projectId: string;
  name: string;
  workspacePath: string;
}

export function resolveRelayRoot(defaultRoot: string, configuredRoot = process.env.RELAY_ROOT): string {
  return configuredRoot ? path.resolve(configuredRoot) : defaultRoot;
}

function isGeneratedName(name: string, directoryPath: string): boolean {
  return name === (path.basename(directoryPath) || 'Relay')
    || LEGACY_DEFAULT_PROJECT_NAMES.has(name);
}

function chooseMigratedName(legacyProject: Project, workspaceProject: Project | undefined, relayRoot: string, workspacePath: string): string {
  if (!isGeneratedName(legacyProject.name, relayRoot)) return legacyProject.name;
  if (workspaceProject && !isGeneratedName(workspaceProject.name, workspacePath)) return workspaceProject.name;
  return DEFAULT_PROJECT_NAME;
}

export function ensureDefaultProject(
  relayRoot: string,
  repository: DefaultProjectRepository,
  filesystem: Pick<typeof fs, 'mkdirSync'> = fs,
  ownerUserId?: string,
): DefaultProjectResult {
  const workspacePath = path.join(relayRoot, 'workspace');
  filesystem.mkdirSync(workspacePath, { recursive: true });

  const findProject = (projectPath: string): Project | undefined => {
    if (!ownerUserId || !repository.getProjectByPathForOwner) return repository.getProjectByPath(projectPath);
    const owned = repository.getProjectByPathForOwner(projectPath, ownerUserId);
    if (owned) return owned;
    const legacy = repository.getProjectByPath(projectPath);
    return legacy?.owner_user_id == null ? legacy : undefined;
  };
  const workspaceProject = findProject(workspacePath);
  const legacyProject = findProject(relayRoot);

  if (legacyProject?.is_system) {
    const name = chooseMigratedName(legacyProject, workspaceProject, relayRoot, workspacePath);
    repository.migrateDefaultProject(
      legacyProject.id,
      workspacePath,
      name,
      workspaceProject && workspaceProject.id !== legacyProject.id ? workspaceProject.id : undefined,
    );
    return { action: 'migrated', projectId: legacyProject.id, name, workspacePath };
  }

  if (workspaceProject) {
    const name = isGeneratedName(workspaceProject.name, workspacePath)
      ? DEFAULT_PROJECT_NAME
      : workspaceProject.name;
    const needsUpdate = !workspaceProject.is_system || name !== workspaceProject.name;
    if (needsUpdate) {
      repository.updateProject(workspaceProject.id, { name, is_system: 1 });
    }
    return { action: needsUpdate ? 'updated' : 'unchanged', projectId: workspaceProject.id, name, workspacePath };
  }

  const created = repository.createProject(DEFAULT_PROJECT_NAME, workspacePath, true, ownerUserId ?? null);
  return { action: 'created', projectId: created.id, name: DEFAULT_PROJECT_NAME, workspacePath };
}
