import { createStoredApplication, type StoredApplicationOptions } from './stored-application.js';
import type { StoredApplicationScope } from './stored-application-host.js';
import { createStoredProductionEngines } from './stored-production-engines.js';
import { createStoredProductionDependencies, type StoredProductionDependencyOptions } from './stored-production-dependencies.js';
import { AttachmentProbe } from './storage/attachment-probe.js';
import { RuntimeFileProjection } from './storage/runtime-file-projection.js';
import { StorageContractError } from './storage/command-boundary.js';
import { codeBuddyProcessManager } from './codebuddy/process-manager.js';
import { openCodeProcessManager } from './opencode/process-manager.js';
import { zcodeProcessManager } from './zcode/process-manager.js';
import { feishuExecutionResource, isFeishuExecutionResource } from './integrations/feishu-im/native-session-scope.js';
import { FEISHU_MAX_CONCURRENCY } from './contracts/dto.js';

export interface StoredProductionApplicationOptions extends Omit<StoredProductionDependencyOptions, 'engines' | 'attachmentAvailability'> {
  root: string;
  storage: StoredApplicationOptions['storage'];
  storageOwner?: StoredApplicationOptions['storageOwner'];
}

/** Builds the Native application after local startup migration; the entry owns activation and listeners. */
export async function prepareStoredProductionApplication(options: StoredProductionApplicationOptions) {
  let configured: Awaited<ReturnType<typeof createStoredProductionDependencies>> | undefined;
  let scope: StoredApplicationScope | undefined;
  const engines = createStoredProductionEngines({ root: options.root, withCodexReady: work => {
    if (!configured) throw new StorageContractError('NOT_SUBMITTED');
    return configured.withCodexReady(work);
  } });
  const attachments = new AttachmentProbe(), files = new RuntimeFileProjection();
  try {
    const defaultConcurrency=Object.fromEntries(engines.registry.list().flatMap(adapter=>{
      const resource=adapter.concurrency?.resolveResource({sessionId:'default',projectId:'default'});
      return resource ? [[resource.resourceKey,resource.defaultMaxActiveTurns], [feishuExecutionResource(adapter.id),FEISHU_MAX_CONCURRENCY]] : [];
    }));
    const application=await createStoredApplication({ storage: {...options.storage,defaultConcurrency:{...defaultConcurrency,...options.storage.defaultConcurrency}}, storageOwner: options.storageOwner,
      afterRuntimeSuspend:async()=>{await Promise.all([codeBuddyProcessManager.closeAll(),openCodeProcessManager.closeAll(),zcodeProcessManager.shutdown()]);},
      runtime: { registry: engines.registry, attachmentAvailability: () => false,
        loadAttachmentAvailability: async paths => {
          const values = new Map(await attachments.check(paths));
          return filename => values.get(filename) ?? false;
        },
        resolveResource: key => {
          if (isFeishuExecutionResource(key)) return { label: '飞书', defaultMaxActiveTurns: FEISHU_MAX_CONCURRENCY };
          for (const adapter of engines.registry.list()) {
            const resource = adapter.concurrency?.resolveResource({ sessionId: 'default', projectId: 'default' });
            if (resource?.resourceKey === key) return resource;
          }
          return null;
        },
        collectFileChanges: async runtime => {
          const binding = scope?.graph.connections.getBinding(runtime.sessionId);
          if (!binding || binding.runtime !== runtime) return { changedFilesIncomplete: true };
          try { return await files.collect(runtime.turnItems, binding.session.projectPath); }
          catch { options.diagnostic('RUNTIME_FILE_PROJECTION_UNAVAILABLE'); return { changedFilesIncomplete: true }; }
        }, diagnostic: (code,detail)=>{if(detail&&options.runtimeDiagnostic)options.runtimeDiagnostic(code,detail);else options.diagnostic(code);},
      }, dependencies: async context => {
        scope = context;
        context.own(attachments, value => value.dispose());
        context.own(files, value => value.dispose());
        configured = await createStoredProductionDependencies(context, { ...options, engines, attachmentAvailability: () => false });
        configured.dependencies.feishuIm = { keyPath: `${options.storage.filename}.feishu-key`,
          diagnostic: () => options.diagnostic('FEISHU_IM_RECEIVER_UNAVAILABLE'),
          summaryPlatform: {
            getCatalog: () => engines.modelCatalog.get('codex'),
            getApiKey: () => {
              const baseUrl = process.env.OPENAI_BASE_URL?.trim().replace(/\/+$/, '');
              return !baseUrl || baseUrl === 'https://api.openai.com/v1' ? process.env.OPENAI_API_KEY?.trim() || undefined : undefined;
            },
          } };
        return configured.dependencies;
      },
    });
    return{...application,activate:async()=>{
      const result=await application.activate();
      await configured!.managed.completeServiceStartup();
      return result;
    }};
  } catch (error) {
    // Opening the DB can fail before a scope exists; passive resources still belong to this builder.
    await files.dispose(); await attachments.dispose(); engines.close();
    throw error;
  }
}
