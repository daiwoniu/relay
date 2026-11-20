import path from 'node:path';
import { readTaskRegistry,readTaskDirectoryTitle, type TaskRegistryProjection } from './task-registry-reader.js';
import { readWorkspaceRuns } from './workspace-runs-reader.js';
import { readObservedTaskActivity } from './activity-duration.js';
import type { FlowRoleDefinition } from '../integrations/feishu/client.js';

/** Current repository rule: defect collaborators participate in handling, with IDs resolved by Feishu. */
export function taskRegistryResponsibilityRoles(type: string, definitions: FlowRoleDefinition[]): string[] {
  return type === 'issue' ? definitions.filter(role => role.name === '协作人').map(role => role.id) : [];
}

/** First supported repository format. External objects never determine local delivery identity. */
export class TaskRegistryAdapter {
  private pending: Promise<TaskRegistryProjection> | null = null;
  constructor(readonly root: string, readonly workspaceId: string) {}
  registry(): Promise<TaskRegistryProjection> {
    if (!this.pending) this.pending = readTaskRegistry(this.root).finally(() => { this.pending = null; });
    return this.pending;
  }
  associations(): Promise<TaskRegistryProjection> {
    return readTaskRegistry(this.root, {includeEvidence:false});
  }
  async runs() {
    const [registry, runs] = await Promise.all([this.registry(), readWorkspaceRuns(this.root)]);
    const byDirectory = new Map<string, string | null>();
    for (const task of registry.tasks) if (task.taskPath) {
      const key = path.resolve(this.root, task.taskPath).toLowerCase();
      byDirectory.set(key, byDirectory.has(key) ? null : task.id);
    }
    const titles=new Map<string,Promise<string|null>>();
    return Promise.all(runs.map(async run => {
      if(!run.taskId)return run;
      const directory=path.join('tasks',run.taskId),key=path.resolve(this.root,directory).toLowerCase();
      const taskId=byDirectory.get(key)??null;
      const association=byDirectory.has(key)?taskId?'registered' as const:'ambiguous' as const:'unregistered' as const;
      let title=taskId?registry.tasks.find(task=>task.id===taskId)?.title??null:null;
      if(!title){
        let pending=titles.get(directory);
        if(!pending){pending=readTaskDirectoryTitle(this.root,directory);titles.set(directory,pending);}
        title=await pending;
      }
      return {...run,taskId,taskContext:{directory,title,association}};
    }));
  }
  durations(taskIds: string[], now: number) { return readObservedTaskActivity(this.root, taskIds, now); }
}
