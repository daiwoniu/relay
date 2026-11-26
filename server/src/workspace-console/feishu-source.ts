import { configuredFeishuClient } from '../integrations/feishu/connection.js';
import { FeishuResponsibilityService, hasUnverifiedResponsibility, type FeishuResponsibility } from '../integrations/feishu/responsibility.js';
import { FeishuApiError, type FeishuProjectClient } from '../integrations/feishu/client.js';
import { ServiceError } from '../services/errors.js';
import type { ExpectedIdentity, WorkspaceResponsibilitySnapshot } from './responsibility-report-source.js';
import { taskRegistryResponsibilityRoles } from './task-registry-adapter.js';
import { WORKSPACE_SETTINGS } from './workspace-config.js';

/** Consumer projection only; the integration never imports a workbench DTO or a local repository. */
export function projectFeishuSnapshot(report: FeishuResponsibility, userKey: string, projectKey?: string): WorkspaceResponsibilitySnapshot {
  const actionable = report.facts.filter(fact => ['current', 'state_responsibility', 'upcoming'].includes(fact.actionability)||fact.type==='issue'&&fact.myResponsibility===true&&fact.archived===true);
  const items = actionable.map(fact => ({ workItemId: fact.id, title: fact.title, typeName: fact.typeName, typeKey: fact.type, reasons: fact.reasons,
    ...(fact.creatorNames?{creatorNames:fact.creatorNames}:{}),
    ...(fact.responsibleNames?{responsibleNames:fact.responsibleNames}:{}),
    ...(fact.fallbackContact ? { fallbackContact: {role:fact.fallbackContact.role,names:fact.fallbackContact.names} } : {}),
    nativeCompleted:fact.archived===true||fact.flowFinished===true?true:fact.archived===false||fact.flowFinished===false?false:null,
    actionability: (fact.actionability==='archived'?'state_responsibility':fact.actionability) as 'current' | 'state_responsibility' | 'upcoming', statusName: fact.statusName,
    ...(fact.linkedStoryIds?{linkedStoryIds:fact.linkedStoryIds}:{}), finishedAt:fact.finishedAt,
    myRoleKeys: fact.myRoles, baseOwnerIsMe: fact.baseOwnerIsMe, createdAt:fact.createdAt??null,updatedAt: fact.updatedAt,
    personalSubtasks: fact.mySubtasks.filter(task => !task.passed).map(task => ({ id: task.id, name: task.title, passed: task.passed, updatedAt: task.updatedAt, finishedAt: task.finishedAt })),
    currentNodes: fact.currentNodes.map(node => node.name), version: null, url: fact.url, localTaskIds: [] }));
  return { reportKind: 'project_responsibility', sourceUserKey: userKey, ...(projectKey ? { sourceProjectKey: projectKey } : {}), relationCoverage: report.relationCoverage, todoEquivalent: false,
    generatedAt: report.generatedAt, fetchedAt: report.fetchedAt, servedFromCache: false,
    complete: report.retrievalComplete && report.classificationComplete, unverifiedCount: report.facts.filter(hasUnverifiedResponsibility).length,
    stale: false, error: null, items, localAssociated: [], counts: {
      current: items.filter(item => item.actionability === 'current').length,
      stateResponsibility: items.filter(item => item.actionability === 'state_responsibility'&&item.nativeCompleted!==true).length,
      upcoming: items.filter(item => item.actionability === 'upcoming').length },
    workbenchItems: report.facts.map(fact => ({ workItemId: fact.id, title: fact.title, typeName: fact.typeName, typeKey: fact.type, reasons: fact.reasons, url: fact.url,
      ...(fact.creatorNames?{creatorNames:fact.creatorNames}:{}),
      ...(fact.responsibleNames?{responsibleNames:fact.responsibleNames}:{}),
      participated:fact.type==='issue'?fact.myResponsibility===true:true,
      ...(fact.linkedStoryIds?{linkedStoryIds:fact.linkedStoryIds}:{}),
      ownerUserKey: fact.owner, roleOwnerUserKeys: fact.roleOwners, stateKey: fact.stateKey, isArchivedState: fact.archived,
      flowFinished: fact.flowFinished, currentNodeNames: fact.currentNodes.map(node => node.name), currentNodes: fact.currentNodes,
      myNodes: fact.myNodes, createdAt:fact.createdAt??null,updatedAt: fact.updatedAt, finishedAt: fact.finishedAt, mySubtasks: fact.mySubtasks })),
  };
}
export class FeishuWorkbenchSource {
  constructor(private readonly client: () => FeishuProjectClient = configuredFeishuClient) {}
  async readIdentity(): Promise<ExpectedIdentity> {
    const { projectKey, userKey, scope } = this.client().config; return { projectKey, userKey, scope };
  }
  async loadFresh(expected: ExpectedIdentity): Promise<WorkspaceResponsibilitySnapshot> {
    const client = this.client();
    if (client.config.scope !== expected.scope || client.config.userKey !== expected.userKey || client.config.projectKey !== expected.projectKey) throw new Error('RESPONSIBILITY_IDENTITY_CHANGED');
    try {
      const options: Record<string,string> = WORKSPACE_SETTINGS.adapterOptions;
      return projectFeishuSnapshot(await new FeishuResponsibilityService(client, Date.now, taskRegistryResponsibilityRoles,options.ADAPTER_STORY_RELATION_FIELD).load(), expected.userKey, expected.projectKey);
    } catch (error) {
      // Only controlled integration errors cross the API boundary; never expose provider payloads.
      const stage = error instanceof Error ? error.stack?.match(/FeishuProjectClient\.([A-Za-z]+)/)?.[1] ?? 'responsibility' : 'responsibility';
      console.warn(`[Relay:Feishu] responsibility read failed: ${error instanceof FeishuApiError ? error.kind : 'validation'}; stage=${stage}`);
      if (error instanceof FeishuApiError) throw new ServiceError(502,
        error.kind === 'permission' ? '飞书连接鉴权或权限校验失败，请核对连接配置与工作项访问权限' : error.kind === 'rate_limit' ? '飞书接口限流，请稍后重试' : error.kind === 'network' ? '飞书接口连接失败或超时，请核对网络后重试' : '飞书接口响应异常，本次责任报表未能更新', 'FEISHU_SOURCE_UNAVAILABLE');
      throw new ServiceError(502, '飞书返回数据未通过结构或责任证据校验，本次报表未能更新', 'FEISHU_SOURCE_INVALID');
    }
  }
}
