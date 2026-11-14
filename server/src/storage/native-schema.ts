import type { nativeQueries } from './native-queries.js';
import { createPurgeSchema } from './native-purge.js';
import { createSoftDeleteSchema } from './native-soft-delete.js';
import { createThemeAssetSchema } from './native-theme-assets.js';
import { createLocalUsageSchema } from './native-local-usage.js';
import { createProviderSnapshotSchema } from './native-provider-snapshots.js';
import { createUploadCleanupSchema } from './native-upload-cleanup.js';
import { createInteractionResponseSchema } from './native-interaction-response.js';
import { createStandaloneSchema } from './native-standalone-interactions.js';
import { createAsyncQuestionSchema } from './native-async-questions.js';
import { createCreditResetSchema } from './native-credit-reset.js';

/** The first candidate support migration. Keep historical migration SQL immutable after release. */
export function createNativeSupportSchema(db:ReturnType<typeof nativeQueries>,storeId:string){
        db.exec(`CREATE TABLE _relay_maintenance_fence(singleton INTEGER PRIMARY KEY CHECK(singleton=1),fence_id TEXT NOT NULL UNIQUE,
          engine_id TEXT,acquired_at INTEGER NOT NULL)`);
        db.exec(`CREATE TABLE _relay_storage_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),store_id TEXT NOT NULL,format_version INTEGER NOT NULL,
          news_initialized INTEGER NOT NULL DEFAULT 0 CHECK(news_initialized IN (0,1)));
          CREATE TABLE _relay_storage_operations(operation_id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,command_name TEXT NOT NULL,input_digest TEXT NOT NULL,
            scope_session_id TEXT,principal_json TEXT NOT NULL,result_json TEXT,committed_at INTEGER NOT NULL,expired INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE _relay_credential_operations(operation_id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,authorizer_hash TEXT NOT NULL,
            command_name TEXT NOT NULL,public_digest TEXT NOT NULL,secret_verifier TEXT NOT NULL,subject_user_id TEXT NOT NULL,
            result_json TEXT,committed_at INTEGER NOT NULL,expired INTEGER NOT NULL DEFAULT 0);
          CREATE UNIQUE INDEX _relay_credential_login_token ON _relay_credential_operations(authorizer_hash) WHERE command_name='auth.login';`);
        db.exec(`CREATE UNIQUE INDEX _relay_one_stop_per_attempt ON _relay_storage_operations(scope_session_id,json_extract(result_json,'$.attemptId'))
          WHERE command_name='turn.requestStop' AND json_extract(result_json,'$.requested')=1`);
        db.exec(`CREATE INDEX _relay_fact_turn_owner ON engine_turn_facts(session_id,engine,external_session_id,external_turn_id,attempt_id)`);
        db.exec(`CREATE TABLE _relay_storage_observations(scope TEXT PRIMARY KEY,latest_issued INTEGER NOT NULL,
          latest_applied INTEGER NOT NULL,snapshot_digest TEXT)`);
        db.exec(`CREATE TABLE _relay_external_operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,actor_user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,source_digest TEXT NOT NULL,external_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('prepared','dispatched','applied')),
          created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
          CREATE UNIQUE INDEX _relay_external_pending ON _relay_external_operations(kind,session_id) WHERE phase IN ('prepared','dispatched')`);
        db.exec(`CREATE TABLE _relay_repair_backups(id TEXT PRIMARY KEY,owner_user_id TEXT NOT NULL,entries_digest TEXT NOT NULL,
          created_at INTEGER NOT NULL,consumed INTEGER NOT NULL,filename TEXT NOT NULL,writer_nonce TEXT NOT NULL,change_counter INTEGER NOT NULL,data_version INTEGER NOT NULL)`);
        db.exec(`CREATE TABLE _relay_forks(id TEXT PRIMARY KEY REFERENCES _relay_external_operations(id),plan_json TEXT NOT NULL,child_id TEXT,claim_token TEXT);
          CREATE TABLE _relay_fork_messages(operation_id TEXT NOT NULL REFERENCES _relay_forks(id),ordinal INTEGER NOT NULL,source_id TEXT NOT NULL,target_id TEXT NOT NULL UNIQUE,source_digest TEXT NOT NULL,
            PRIMARY KEY(operation_id,ordinal),UNIQUE(operation_id,source_id))`);
        createPurgeSchema(db);
        createSoftDeleteSchema(db);
        createThemeAssetSchema(db);
        createLocalUsageSchema(db);
        createProviderSnapshotSchema(db);
        createUploadCleanupSchema(db);
        createInteractionResponseSchema(db);
        createStandaloneSchema(db);
        createAsyncQuestionSchema(db);
        createCreditResetSchema(db);
        db.exec(`CREATE TABLE _relay_send_intents(actor_user_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,message_id TEXT NOT NULL,intent_digest TEXT NOT NULL,
          operation_id TEXT NOT NULL UNIQUE,PRIMARY KEY(actor_user_id,session_id,message_id))`);
        db.run('INSERT INTO _relay_storage_meta(singleton,store_id,format_version) VALUES(1,?,1)', [storeId]);

}
