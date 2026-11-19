import { parentPort,workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { nativeQueries } from '../storage/native-queries.js';
import { readAnalytics } from '../storage/native-analytics.js';
import { AnalyticsQuerySchema } from './contract.js';
import { readFeatureAnalytics } from './read-features.js';

const database=new DatabaseSync(workerData.filename,{readOnly:true});
database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;');
const db=nativeQueries(database);
parentPort!.on('message',message=>{
  try{
    let value:unknown;
    if(message.view==='actor'){
      value=db.get(`SELECT u.id AS userId,u.role FROM engine_terminal_decisions d
        JOIN messages m ON m.session_id=d.session_id AND m.turn_id=d.attempt_id AND m.role='user'
        JOIN users u ON u.id=json_extract(m.metadata,'$.origin.senderUserId')
        WHERE d.id=? AND d.session_id=? AND d.projected_at IS NOT NULL LIMIT 1`,[message.decisionId,message.sessionId])??null;
    }else{
      const query=AnalyticsQuerySchema.parse(message.query);
      if(!['summary','visits','features','actions'].includes(message.view))throw Error('INVALID_VIEW');
      // One snapshot per response, without sharing the business writer's queue.
      database.exec('BEGIN');
      try{const asOf=Date.now(),data=['features','actions'].includes(message.view)?readFeatureAnalytics(db,query,message.view,message.cursor,asOf):readAnalytics(db,query,message.view,asOf);value=message.snapshot===true?{data,asOf,cached:false}:data;database.exec('COMMIT');}
      catch(error){database.exec('ROLLBACK');throw error;}
    }
    parentPort!.postMessage({value});
  }catch{parentPort!.postMessage({error:'ANALYTICS_UNAVAILABLE'});}
});
