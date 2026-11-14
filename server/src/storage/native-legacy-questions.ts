import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { canonicalJson,StorageContractError } from './command-boundary.js';
import { ProcessItemDtoSchema } from '../contracts/index.js';

// Immutable data migration script; its exact statements are included in the application migration checksum.
export const LEGACY_QUESTION_MIGRATION_SQL={
  damaged:`SELECT 1 FROM messages WHERE role='assistant' AND items IS NOT NULL AND
    (instr(items,'async_question')>0 OR instr(items,'async-question:')>0)
    AND CASE WHEN json_valid(items) THEN json_type(items)<>'array' ELSE 1 END LIMIT 1`,
  damagedAnswers:`SELECT 1 FROM messages WHERE role='user' AND metadata IS NOT NULL AND instr(metadata,'replyToAsyncQuestionId')>0
    AND CASE WHEN json_valid(metadata) THEN COALESCE(json_type(metadata,'$.replyToAsyncQuestionId') NOT IN ('text','null'),0) ELSE 1 END LIMIT 1`,
  questions:`CREATE TEMP TABLE _relay_migration_questions AS
    SELECT m.session_id,m.id AS source_message_id,m.turn_id,m.created_at,
      json_extract(j.value,'$.id') AS question_id,relay_migration_question(j.value) AS item_json
    FROM messages m JOIN sessions s ON s.id=m.session_id
    JOIN json_each(CASE WHEN json_valid(m.items) THEN m.items ELSE '[]' END) j
    WHERE m.role='assistant' AND s.engine='codex' AND j.type='object'
      AND json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.type')='interaction'
      AND json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.details.interactionKind')='async_question'`,
  answers:`CREATE TEMP TABLE _relay_migration_answers AS
    SELECT session_id,id AS message_id,json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,'$.replyToAsyncQuestionId') AS question_id
      FROM messages WHERE role='user' AND json_type(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,'$.replyToAsyncQuestionId')='text'
    UNION SELECT session_id,id,reply_to_async_question_id FROM session_followups WHERE state<>'cancelled' AND reply_to_async_question_id IS NOT NULL`,
  conflictingQuestions:`SELECT 1 FROM _relay_migration_questions GROUP BY session_id,question_id HAVING COUNT(DISTINCT item_json)>1 LIMIT 1`,
  conflictingAnswers:`SELECT 1 FROM _relay_migration_answers a JOIN _relay_migration_questions q ON q.session_id=a.session_id AND q.question_id=a.question_id
    GROUP BY a.session_id,a.question_id HAVING COUNT(DISTINCT a.message_id)>1 LIMIT 1`,
  insert:`INSERT INTO _relay_async_questions(session_id,question_id,attempt_id,turn_id,item_json,item_digest,answer_message_id,created_at)
    SELECT q.session_id,q.question_id,'legacy-index:'||relay_migration_sha256(q.session_id||char(0)||q.question_id),
      COALESCE(q.turn_id,'legacy-index:'||q.source_message_id),q.item_json,relay_migration_sha256(q.item_json),
      (SELECT MIN(a.message_id) FROM _relay_migration_answers a WHERE a.session_id=q.session_id AND a.question_id=q.question_id),q.created_at
    FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY session_id,question_id ORDER BY created_at,source_message_id) AS ordinal FROM _relay_migration_questions) q
    WHERE q.ordinal=1`,
  cleanup:'DROP TABLE IF EXISTS temp._relay_migration_answers;DROP TABLE IF EXISTS temp._relay_migration_questions',
  validation:'canonical-json-v1; ProcessItemDto-v1; async-question-id<=256; in_progress; question-count=1..16; title<=2000; option-count<=100; option<=2000',
} as const;

/** Builds an index only. Historical messages and followups remain byte-for-byte unchanged.
 * legacy-index identifies an unknown historical attempt; it is never submitted as an engine execution fact. */
export function backfillLegacyQuestions(db:DatabaseSync){
  if(!db.isTransaction)throw new StorageContractError('CONFLICT');
  const questions=z.array(z.object({title:z.string().trim().min(1).max(2000),options:z.array(z.string().min(1).max(2000)).max(100).optional()}).strict()).min(1).max(16);
  db.function('relay_migration_sha256',{deterministic:true},value=>{if(typeof value!=='string')throw Error('MIGRATION_INVALID_VALUE');return createHash('sha256').update(value).digest('hex');});
  db.function('relay_migration_question',{deterministic:true},value=>{
    if(typeof value!=='string')throw Error('MIGRATION_INVALID_QUESTION');
    const item=JSON.parse(value);ProcessItemDtoSchema.parse(item);
    if(typeof item.id!=='string'||!item.id.startsWith('async-question:')||item.id.length>256||item.status!=='in_progress'||item.details.interactionKind!=='async_question')throw Error('MIGRATION_INVALID_QUESTION');
    questions.parse(item.details.questions);return canonicalJson(item,256*1024);
  });
  try{
    if(db.prepare(LEGACY_QUESTION_MIGRATION_SQL.damaged).get()||db.prepare(LEGACY_QUESTION_MIGRATION_SQL.damagedAnswers).get())throw new StorageContractError('CONFLICT');
    db.exec(LEGACY_QUESTION_MIGRATION_SQL.questions);db.exec(LEGACY_QUESTION_MIGRATION_SQL.answers);
    if(db.prepare(LEGACY_QUESTION_MIGRATION_SQL.conflictingQuestions).get()||db.prepare(LEGACY_QUESTION_MIGRATION_SQL.conflictingAnswers).get())throw new StorageContractError('CONFLICT');
    db.exec(LEGACY_QUESTION_MIGRATION_SQL.insert);
  }finally{db.exec(LEGACY_QUESTION_MIGRATION_SQL.cleanup);}
}
