import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,markRead } from './storage-fixture.test-support.js';
import { NativeStore } from './native-store.js';
import type { CoreCommandInputs, StorageCommandEnvelope } from './contracts.js';
function enqueue(id:string,content:string,title='新对话',manual=false,metadata:CoreCommandInputs['turn.enqueue']['metadata']=null):StorageCommandEnvelope{
  return{...markRead(),operationId:'send-'+id,command:{name:'turn.enqueue',input:{sessionId:id,attemptId:'attempt-'+id,messageId:'message-'+id,engineId:'codex',resourceKey:'codex:default',content,metadata,expectedPreferencesRevision:0,
    origin:{kind:'direct'},draft:{projectId:'project',title,titleManuallySet:manual}}}};
}
test('accepted Native sends atomically apply ordinary automatic titles and preserve ignored/contextual/fixed-title behavior',()=>{
  const f=fixture();f.mutate('DELETE FROM engine_resource_leases');const store=new NativeStore(f.filename,'store',1,true);
  try{
    for(const [id,content,title,manual,expected]of [
      ['ignore','继续','新对话',false,'新对话'],
      ['topic','修复上传附件的恢复问题','新对话',false,'修复上传附件的恢复问题'],
      ['task','修复上传附件的恢复问题','固定任务标题',true,'固定任务标题'],
      ['contextual','开始实施吧','已有业务标题',false,'已有业务标题'],
    ] as const){
      const request=enqueue(id,content,title,manual);assert.equal(store.execute(request).state,'committed');assert.equal(f.scalar(`SELECT title FROM sessions WHERE id='${id}'`),expected);
      assert.equal(store.execute(request).state,'committed');assert.equal(f.scalar(`SELECT title_manually_set FROM sessions WHERE id='${id}'`),Number(manual));
    }
    const attachment=enqueue('attachment','','新对话',false,{attachments:[{kind:'host_file',id:randomUUID(),name:'report.xlsx',path:'D:/synthetic/report.xlsx',size:1}]});
    assert.equal(store.execute(attachment).state,'committed');assert.equal(f.scalar("SELECT title FROM sessions WHERE id='attachment'"),'查看文件 report.xlsx');
  }finally{store.close();f.cleanup();}
});
test('receipt failure rolls back the title with its accepted message and queue',()=>{
  const f=fixture();f.mutate('DELETE FROM engine_resource_leases');const store=new NativeStore(f.filename,'store',1,true);
  try{
    f.mutate("CREATE TRIGGER title_receipt_failure BEFORE INSERT ON _relay_storage_operations WHEN NEW.command_name='turn.enqueue' BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    const request=enqueue('atomic-title','修复标题原子提交');assert.equal(store.execute(request).state,'unknown');
    assert.equal(f.scalar("SELECT COUNT(*) FROM sessions WHERE id='atomic-title'"),0);assert.equal(f.scalar("SELECT COUNT(*) FROM messages WHERE id='message-atomic-title'"),0);
    f.mutate('DROP TRIGGER title_receipt_failure');assert.equal(store.execute(request).state,'committed');assert.equal(f.scalar("SELECT title FROM sessions WHERE id='atomic-title'"),'修复标题原子提交');
  }finally{store.close();f.cleanup();}
});
