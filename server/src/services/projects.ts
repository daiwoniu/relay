import fs from 'node:fs';
import path from 'node:path';
import * as queries from '../db/queries.js';
import type { Project, Session } from '../db/queries.js';
import { presentProject, presentPublicUser, type ProjectDeletionImpactDto, type ProjectDto, type PublicUserDto } from '../contracts/index.js';
import { ServiceError } from './errors.js';
import { isSessionInProgress } from './session-runtime-status.js';
import type { SessionDeletionRecord } from './session-deletion.js';
import { deletionState as sharedDeletionState, type DeletionState } from './deletion-state.js';
import { ensureProjectFiles } from '../default-workspace.js';
import { canManageOwnedResource, requireOwnedResource, visibleOwnerUserId, type Actor } from '../auth/authorization.js';
import type { User } from '../db/queries.js';
import type { ProjectMemberRole } from '../db/project-members.js';
import { recordAdminAudit, runAdminAuditedAction, runAdminAuditedExternalAction, type AdminAuditInput } from '../db/admin-audit.js';

export interface ProjectRepository {
  listProjects(): Project[];
  listProjectsForActor?(ownerUserId?: string): Project[];
  getProject(id: string): Project | undefined;
  getProjectForActor?(id: string, ownerUserId?: string): Project | undefined;
  getProjectMemberRole?(projectId: string, userId: string): ProjectMemberRole | null;
  listProjectMembers?(projectId: string): Array<{ user_id: string; role: ProjectMemberRole; can_view_sessions: 0 | 1 }>;
  upsertProjectMember?(projectId: string, userId: string, role: ProjectMemberRole, canViewSessions?: 0 | 1): void;
  removeProjectMember?(projectId: string, userId: string): void;
  listUsers?(): User[];
  getProjectByPath(projectPath: string): Project | undefined;
  getProjectByPathForOwner?(projectPath: string, ownerUserId: string): Project | undefined;
  restoreProject(id: string, name: string): Project;
  createProject(name: string, projectPath: string, isSystem?: boolean, ownerUserId?: string | null): Project;
  getUserById?(id: string): User | undefined;
  updateProject(id: string, updates: Partial<Pick<Project, 'name' | 'pinned' | 'is_system' | 'deletion_protected' | 'members_can_view_sessions'>>): void;
  listSessionsByProject(projectId: string): Session[];
  countSessionsByProjectIncludingDeleted(projectId: string): number;
  deleteProject(id: string): void;
}

export interface ProjectFilesystemPort {
  isAbsolute(projectPath: string): boolean;
  realpath(projectPath: string): string;
  isDirectory(projectPath: string): boolean;
  basename(projectPath: string): string;
}

export interface ProjectRuntimePort {
  closeProjectConnections(projectId: string): void;
}

export interface ProjectSidebarOrderPort {
  changed(): void;
}

export interface ProjectBroadcastPort {
  projectUpdated(project: ProjectDto, ownerUserId?: string | null): void;
  projectDeleted(projectId: string, ownerUserId: string): void;
  memberGranted?(project: ProjectDto, userId: string): void;
  memberRevoked?(projectId: string, userId: string): void;
}

export interface ProjectSessionDeletionPort {
  prepare(session: SessionDeletionRecord): Promise<void>;
}

const nodeFilesystem: ProjectFilesystemPort = {
  isAbsolute: path.isAbsolute,
  realpath: fs.realpathSync,
  isDirectory: (projectPath) => fs.statSync(projectPath).isDirectory(),
  basename: (projectPath) => path.basename(projectPath),
};

const noProjectRuntime: ProjectRuntimePort = { closeProjectConnections: () => undefined };
const noProjectSidebarOrder: ProjectSidebarOrderPort = { changed: () => undefined };
const noProjectBroadcast: ProjectBroadcastPort = {
  projectUpdated: () => undefined,
  projectDeleted: () => undefined,
};
const noProjectSessionDeletion: ProjectSessionDeletionPort = { prepare: async () => undefined };
const initializeDefaultProjectFiles = (projectPath: string): void => { ensureProjectFiles(projectPath); };

export function createProjectService({
  repository = queries,
  filesystem = nodeFilesystem,
  runtime = noProjectRuntime,
  sidebarOrder = noProjectSidebarOrder,
  broadcast = noProjectBroadcast,
  deletion = noProjectSessionDeletion,
  deletionState = sharedDeletionState,
  initializeProjectFiles = initializeDefaultProjectFiles,
  audit = repository === queries ? recordAdminAudit : () => false,
}: {
  repository?: ProjectRepository;
  filesystem?: ProjectFilesystemPort;
  runtime?: ProjectRuntimePort;
  sidebarOrder?: ProjectSidebarOrderPort;
  broadcast?: ProjectBroadcastPort;
  deletion?: ProjectSessionDeletionPort;
  deletionState?: DeletionState;
  initializeProjectFiles?: (projectPath: string) => void;
  audit?: (input: AdminAuditInput) => boolean;
} = {}) {
  const useDefaultAudit = repository === queries && audit === recordAdminAudit;
  const audited = <T>(input: AdminAuditInput, action: () => T): T => {
    if (useDefaultAudit) return runAdminAuditedAction(input, action);
    const result = action();
    audit({ ...input, result: 'succeeded' });
    return result;
  };
  const auditedExternal = async <T>(input: AdminAuditInput, action: () => Promise<T>): Promise<T> => {
    if (useDefaultAudit) return runAdminAuditedExternalAction(input, action);
    const result = await action();
    audit({ ...input, result: 'succeeded' });
    return result;
  };
  const presentOwnedProject = (project: Project): ProjectDto => presentProject(
    project,
    project.owner_user_id ? repository.getUserById?.(project.owner_user_id) : null,
  );
  return {
    listForActor(actor: Actor): ProjectDto[] {
      const ownerUserId = visibleOwnerUserId(actor);
      const projects = repository.listProjectsForActor
        ? repository.listProjectsForActor(ownerUserId)
        : repository.listProjects().filter((project) => canManageOwnedResource(actor, project.owner_user_id));
      return projects.map((project) => presentOwnedProject({ ...project, access_role: project.owner_user_id === actor.userId ? 'owner' : (repository.getProjectMemberRole?.(project.id, actor.userId) ?? undefined) }));
    },

    getForActor(actor: Actor, id: string): ProjectDto | undefined {
      const ownerUserId = visibleOwnerUserId(actor);
      const project = repository.getProjectForActor
        ? repository.getProjectForActor(id, ownerUserId)
        : repository.getProject(id);
      if (!project || (!canManageOwnedResource(actor, project.owner_user_id) && !repository.getProjectMemberRole?.(id, actor.userId))) return undefined;
      return presentOwnedProject({
        ...project,
        access_role: project.owner_user_id === actor.userId
          ? 'owner'
          : (repository.getProjectMemberRole?.(project.id, actor.userId) ?? undefined),
      });
    },

    list(): ProjectDto[] {
      return repository.listProjects().map(presentOwnedProject);
    },

    get(id: string): ProjectDto | undefined {
      const project = repository.getProject(id);
      return project ? presentOwnedProject(project) : undefined;
    },

    getDeletionImpact(id: string): ProjectDeletionImpactDto {
      if (!repository.getProject(id)) throw new ServiceError(404, '项目不存在');
      const sessions = repository.listSessionsByProject(id);
      return {
        sessionCount: sessions.length,
        linkedCodexSessionCount: sessions.filter((session) => Boolean(session.codex_thread_id)).length,
        inProgressSessionCount: sessions.filter((session) => isSessionInProgress(session.status)).length,
      };
    },

    getDeletionImpactForActor(actor: Actor, id: string): ProjectDeletionImpactDto {
      requireOwnedResource(actor, repository.getProject(id), '项目');
      return this.getDeletionImpact(id);
    },

    listMembersForActor(actor: Actor, id: string): Array<{ user_id: string; role: ProjectMemberRole; can_view_sessions: 0 | 1 }> {
      const project = this.getForActor(actor, id);
      if (!project) throw new ServiceError(404, '项目不存在');
      if (!canManageProjectMembers(actor, project)) throw new ServiceError(403, '没有权限管理项目授权', 'PROJECT_MEMBER_FORBIDDEN');
      if (repository.listProjectMembers) return repository.listProjectMembers(id);
      return queries.listProjectMembers(id);
    },

    listMemberCandidatesForActor(actor: Actor, id: string): PublicUserDto[] {
      const project = this.getForActor(actor, id);
      if (!project) throw new ServiceError(404, '项目不存在');
      if (!canManageProjectMembers(actor, project)) throw new ServiceError(403, '没有权限管理项目授权', 'PROJECT_MEMBER_FORBIDDEN');
      const users = repository.listUsers ? repository.listUsers() : queries.listUsers();
      return users.map(presentPublicUser);
    },

    upsertMemberForActor(actor: Actor, id: string, input: { userId: string; role: ProjectMemberRole; can_view_sessions?: 0 | 1 }): void {
      const project = this.getForActor(actor, id);
      if (!project) throw new ServiceError(404, '项目不存在');
      if (!canManageProjectMembers(actor, project)) throw new ServiceError(403, '没有权限管理项目授权', 'PROJECT_MEMBER_FORBIDDEN');
      if (project.owner?.id === input.userId) throw new ServiceError(400, '不能把项目所有者添加为成员');
      if (!repository.getUserById?.(input.userId)) throw new ServiceError(404, '账号不存在');
      if (repository.upsertProjectMember) repository.upsertProjectMember(id, input.userId, input.role, input.can_view_sessions);
      else queries.upsertProjectMember(id, input.userId, input.role, input.can_view_sessions);
      const granted = presentOwnedProject({
        ...repository.getProject(id)!,
        access_role: input.role,
      });
      broadcast.memberGranted?.(granted, input.userId);
    },

    removeMemberForActor(actor: Actor, id: string, userId: string): void {
      const project = this.getForActor(actor, id);
      if (!project) throw new ServiceError(404, '项目不存在');
      if (!canManageProjectMembers(actor, project)) throw new ServiceError(403, '没有权限管理项目授权', 'PROJECT_MEMBER_FORBIDDEN');
      if (repository.removeProjectMember) repository.removeProjectMember(id, userId);
      else queries.removeProjectMember(id, userId);
      broadcast.memberRevoked?.(id, userId);
    },

    createForActor(actor: Actor, input: { path: string; name?: string }): { project: ProjectDto; created: boolean } {
      if (actor.role !== 'admin' && repository.getUserById?.(actor.userId)?.can_create_project === 0) throw new ServiceError(403, '当前账号不允许添加项目', 'PROJECT_CREATE_FORBIDDEN');
      return createProjectForOwner(actor.userId, input);
    },

    create(input: { path: string; name?: string }): { project: ProjectDto; created: boolean } {
      return createProjectForOwner(null, input);
    },

    updateForActor(actor: Actor, id: string, updates: Pick<Partial<Project>, 'name' | 'pinned' | 'deletion_protected' | 'members_can_view_sessions'>): ProjectDto {
      const project = requireOwnedResource(actor, repository.getProject(id), '项目');
      if (!project.owner_user_id) return this.update(id, updates);
      return audited({ actorUserId: actor.userId, action: 'project.update', resourceType: 'project', resourceId: id, ownerUserId: project.owner_user_id }, () => this.update(id, updates));
    },

    async deleteForActor(actor: Actor, id: string): Promise<void> {
      const project = requireOwnedResource(actor, repository.getProject(id), '项目');
      const owner = project.owner_user_id ? repository.getUserById?.(project.owner_user_id) : undefined;
      if (project.deletion_protected) throw new ServiceError(403, '该项目已设置为不可删除', 'PROJECT_DELETE_PROTECTED');
      if (owner?.default_project_id === id) throw new ServiceError(403, '当前默认项目不允许删除，请先切换默认项目');
      if (!project.owner_user_id) return this.delete(id);
      await auditedExternal({ actorUserId: actor.userId, action: 'project.delete', resourceType: 'project', resourceId: id, ownerUserId: project.owner_user_id }, () => this.delete(id));
    },

    resolveOwnedProjectForSession(actor: Actor, requestedProjectId: string): ProjectDto {
      const requested = repository.getProject(requestedProjectId);
      if (!requested || (!canManageOwnedResource(actor, requested.owner_user_id) && !repository.getProjectMemberRole?.(requested.id, actor.userId))) throw new ServiceError(404, '项目不存在');
      if (requested.owner_user_id === actor.userId) return presentOwnedProject(requested);
      if (actor.role === 'admin') {
        const own = repository.getProjectByPathForOwner?.(requested.path, actor.userId);
        if (own && !own.deleted_at) return presentOwnedProject(own);
        return createProjectForOwner(actor.userId, { path: requested.path, name: requested.name }).project;
      }
      const membership = repository.getProjectMemberRole?.(requested.id, actor.userId);
      if (membership === 'collaborator' || membership === 'manager') return presentOwnedProject(requested);
      throw new ServiceError(403, '没有权限在该项目中创建会话', 'SESSION_CREATE_FORBIDDEN');
    },

    update(id: string, updates: Pick<Partial<Project>, 'name' | 'pinned'>): ProjectDto {
      if (!repository.getProject(id)) throw new ServiceError(404, '项目不存在');
      repository.updateProject(id, updates);
      const project = presentOwnedProject(repository.getProject(id)!);
      broadcast.projectUpdated(project, project.owner?.id);
      if (updates.pinned !== undefined) sidebarOrder.changed();
      return project;
    },

    async delete(id: string): Promise<void> {
      const project = repository.getProject(id);
      if (!project) throw new ServiceError(404, '项目不存在');
      if (project.is_system) throw new ServiceError(403, 'Relay 系统项目不允许删除');
      const sessionIds = repository.listSessionsByProject(id).map((session) => session.id);
      await deletionState.runProjectDeletion(id, sessionIds, async () => {
        const sessions = repository.listSessionsByProject(id);
        if (sessions.some((session) => isSessionInProgress(session.status))) {
          throw new ServiceError(409, '项目中有会话正在处理中，完成后才能删除', 'PROJECT_DELETE_IN_PROGRESS');
        }
        for (const session of sessions) {
          await deletion.prepare(session);
        }
        runtime.closeProjectConnections(id);
        repository.deleteProject(id);
        if (project.owner_user_id) broadcast.projectDeleted(id, project.owner_user_id);
        sidebarOrder.changed();
      });
    },
  };

  function canManageProjectMembers(actor: Actor, _project: ProjectDto): boolean {
    return actor.role === 'admin';
  }

  function createProjectForOwner(ownerUserId: string | null, input: { path: string; name?: string }): { project: ProjectDto; created: boolean } {
      if (!filesystem.isAbsolute(input.path)) throw new ServiceError(400, '项目路径必须是绝对路径');

      let projectPath: string;
      try {
        projectPath = filesystem.realpath(input.path);
        if (!filesystem.isDirectory(projectPath)) throw new ServiceError(400, '项目路径不是目录');
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(400, '项目路径不存在或不可访问');
      }

      const existing = ownerUserId && repository.getProjectByPathForOwner
        ? repository.getProjectByPathForOwner(projectPath, ownerUserId)
        : repository.getProjectByPath(projectPath);
      const defaultName = filesystem.basename(projectPath) || projectPath;
      if (existing) {
        if (existing.deleted_at) {
          throw new ServiceError(409, '项目已在回收站，请确认后恢复', 'PROJECT_IN_TRASH', {
            projectInTrash: {
              id: existing.id,
              name: existing.name,
              sessionCount: repository.countSessionsByProjectIncludingDeleted(existing.id),
            },
          });
        }
        return { project: presentOwnedProject(existing), created: false };
      }
      initializeProjectFiles(projectPath);
      const project = presentOwnedProject(repository.createProject(input.name || defaultName, projectPath, false, ownerUserId));
      broadcast.projectUpdated(project, ownerUserId);
      sidebarOrder.changed();
      return { project, created: true };
  }
}

export const projectService = createProjectService();
