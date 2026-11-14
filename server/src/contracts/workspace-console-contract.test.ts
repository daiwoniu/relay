import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceConsoleDashboardDtoSchema, WorkspaceConsoleResponsibilityDtoSchema, WorkspaceSourceMetaDtoSchema } from './dto.js';

test('workspace console contracts reject credentials and retain Project responsibility semantics', () => {
  const dashboard = { workspacePath: 'D:/demo/workspace', capturedAt: 1, registryGeneratedAt: null, counts: { total: 0, completed: 0, active: 0, runs: 0, sessions: 0 }, tasks: [], runs: [], unmatchedRuns: [], sessions: [], unlinkedSessions: [], errors: [], sourceAvailable: { registry: true, runs: true, sessions: true, links: true, activity: true } };
  assert.equal(WorkspaceConsoleDashboardDtoSchema.safeParse(dashboard).success, true);
  assert.equal(WorkspaceConsoleDashboardDtoSchema.safeParse({ ...dashboard, token: 'secret' }).success, false);
  const responsibility = { reportKind: 'project_responsibility', sourceUserKey: 'user-1', todoEquivalent: false, generatedAt: '2026-09-26T05:00:00+08:00', fetchedAt: 1, complete: true, stale: false, error: null, items: [], workbenchItems: [{ workItemId: '11', title: '父项', typeName: '需求', url: null, ownerUserKey: 'user-1', stateKey: 'doing', isArchivedState: false, flowFinished: false, currentNodeNames: ['实施'], mySubtasks: [] }], localAssociated: [], counts: { current: 0, stateResponsibility: 0, upcoming: 0 } };
  assert.equal(WorkspaceConsoleResponsibilityDtoSchema.safeParse(responsibility).success, true);
  assert.equal(WorkspaceConsoleResponsibilityDtoSchema.safeParse({ ...responsibility, complete: false }).success, true);
  assert.equal(WorkspaceConsoleResponsibilityDtoSchema.safeParse({ ...responsibility, todoEquivalent: true }).success, false);
  assert.equal(WorkspaceConsoleResponsibilityDtoSchema.safeParse({ ...responsibility, workbenchItems: [{ ...responsibility.workbenchItems[0], token: 'secret' }] }).success, false);
  assert.equal(WorkspaceConsoleResponsibilityDtoSchema.safeParse({ ...responsibility, workbenchItems: [{
    ...responsibility.workbenchItems[0], myNodes: [{ id: 'n1', name: '研发', phase: 'completed' }],
  }] }).success, true);
  assert.equal(WorkspaceConsoleResponsibilityDtoSchema.safeParse({ ...responsibility, workbenchItems: [{
    ...responsibility.workbenchItems[0], myNodes: [{ id: 'n1', name: '研发', phase: 'current', ownerCount: 0 }],
  }] }).success, false);
});

test('workspace source metadata describes a failed persisted snapshot without extra fields', () => {
  const meta = { state: 'failed_snapshot', lastSuccessAt: 1000, lastAttemptAt: 2000, error: '飞书暂时不可用' };
  assert.equal(WorkspaceSourceMetaDtoSchema.safeParse(meta).success, true);
  assert.equal(WorkspaceSourceMetaDtoSchema.safeParse({ ...meta, token: 'secret' }).success, false);
});
