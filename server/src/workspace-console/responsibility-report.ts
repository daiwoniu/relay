import { getDB,type SQLiteDB } from '../db/index.js';
import { readWorkspaceSnapshot,writeWorkspaceSnapshot } from '../db/workspace-snapshots.js';
import { WorkspaceConsoleResponsibilityDtoSchema } from '../contracts/dto.js';
import { ResponsibilityReportSource,type ResponsibilityReportSourceOptions,type WorkspaceResponsibilitySnapshot } from './responsibility-report-source.js';
export * from './responsibility-report-source.js';
interface ResponsibilityReportOptions extends ResponsibilityReportSourceOptions{database?:Pick<SQLiteDB,'get'|'run'|'saveToFile'>}
export class ResponsibilityReportService extends ResponsibilityReportSource{
  private readonly database?:Pick<SQLiteDB,'get'|'run'|'saveToFile'>;
  private cached:WorkspaceResponsibilitySnapshot|null=null;private cachedIdentityKey:string|null=null;
  private inflight:Promise<WorkspaceResponsibilitySnapshot>|null=null;private inflightForced=false;
  private queuedForce:Promise<WorkspaceResponsibilitySnapshot>|null=null;
  constructor(options:ResponsibilityReportOptions={}){super(options);this.database=options.database;}
  get(force = false): Promise<WorkspaceResponsibilitySnapshot> {
    if (this.queuedForce) return this.queuedForce;
    if (this.inflight) {
      if (!force || this.inflightForced) return this.inflight;
      this.queuedForce = this.inflight.catch(() => undefined).then(() => {
        this.queuedForce = null;
        return this.get(true);
      });
      return this.queuedForce;
    }
    this.inflightForced = force;
    this.inflight = this.resolve(force).finally(() => { this.inflight = null; this.inflightForced = false; });
    return this.inflight;
  }
  private snapshotDatabase(): Pick<SQLiteDB, 'get' | 'run' | 'saveToFile'> | null {
    try { return this.database ?? getDB(); }
    catch { return null; }
  }

  private async resolve(force: boolean): Promise<WorkspaceResponsibilitySnapshot> {
    const expected = await this.identity();
    const db = this.snapshotDatabase();
    const identityKey = `${expected.scope ? expected.scope + ':' : ''}${expected.projectKey}:${expected.userKey}`;
    if (this.cachedIdentityKey !== identityKey) this.cached = null;
    this.cachedIdentityKey = identityKey;
    if (!this.cached && db) {
      try {
        const previous = readWorkspaceSnapshot(db, 'responsibility', identityKey, WorkspaceConsoleResponsibilityDtoSchema);
        if (previous && previous.value.sourceUserKey === expected.userKey) {
          this.cached = { ...previous.value, fetchedAt: previous.savedAt, servedFromCache: true, stale: false,
            error: null, sourceMeta: { state: 'snapshot', lastSuccessAt: previous.savedAt, lastAttemptAt: null, error: null } };
        }
      } catch { /* Snapshot storage must not block the live report. */ }
    }
    if (!force && this.cached) return { ...this.cached, servedFromCache: true };
    try {
      const value = await this.load(expected);
      const success: WorkspaceResponsibilitySnapshot = { ...value, sourceMeta: { state: 'live',
        lastSuccessAt: value.fetchedAt, lastAttemptAt: value.fetchedAt, error: null } };
      if (db) {
        try { writeWorkspaceSnapshot(db, 'responsibility', identityKey, success, value.fetchedAt); }
        catch { console.warn('[WorkspaceResponsibility] snapshot save failed'); }
      }
      this.cached = success;
      return success;
    } catch (error) {
      if (!this.cached) throw error;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 240);
      this.cached = { ...this.cached, servedFromCache: true, stale: true, error: message,
        sourceMeta: { state: 'failed_snapshot', lastSuccessAt: this.cached.fetchedAt,
          lastAttemptAt: this.now(), error: message } };
      return this.cached;
    }
  }
}
