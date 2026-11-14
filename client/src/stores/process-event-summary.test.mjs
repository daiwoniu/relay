import test from 'node:test';
import assert from 'node:assert/strict';
import { describeWebOperation, describeFileChanges } from './process-event-summary.ts';
import { hasVisibleProcessStep } from './process-step-visibility.ts';
import { isProcessTimelineOperationType } from './process-timeline.ts';

test('网页动作保留搜索、打开与页内查找，只有action的真实记录也可见', () => {
  assert.deepEqual(describeWebOperation({action:{type:'openPage',url:'https://example.test/doc'}}),{title:'打开网页',subtitle:'https://example.test/doc'});
  assert.deepEqual(describeWebOperation({action:{type:'findInPage',url:'https://example.test/doc',pattern:'needle'}}),{title:'页内查找',subtitle:'needle',hint:'网页：https://example.test/doc'});
  assert.deepEqual(describeWebOperation({query:'same',action:{type:'search',query:'same',queries:['same','other']}}),{title:'搜索网页资料',subtitle:'same',hint:'另有 1 个查询'});
  assert.equal(describeWebOperation({action:{type:'future_action'}}).title,'网页操作');
  for(const type of ['openPage','findInPage','search']) assert(hasVisibleProcessStep({id:type,type:'webSearch',status:'completed',details:{action:{type}}}));
});

test('按文件种类识别新增删除与混合变更，路径去重不覆盖明确种类', () => {
  assert.deepEqual(describeFileChanges({path:'a.ts',changes:[{path:'a.ts',kind:{type:'add'}},{path:'b.ts',kind:{type:'delete'}},{path:'c.ts',changeType:'modified'}]}),{paths:['a.ts','b.ts','c.ts'],action:'变更',counts:'新增 1 · 删除 1 · 修改 1'});
  assert.equal(describeFileChanges({changes:[{path:'a.ts',changeType:'deleted'}]}).action,'删除');
  assert.equal(describeFileChanges({changes:[null,{},'a.ts']}).action,'变更');
  assert.deepEqual(describeFileChanges({path:' ',filePath:'a.ts',changes:[],fileChanges:[{path:' ',filePath:'a.ts',changeType:' ',kind:'delete'}]}),{paths:['a.ts'],action:'删除',counts:undefined});
  assert.equal(describeFileChanges({changes:[{path:'a.ts',kind:'add'},{path:'a.ts',kind:'delete'},{path:'a.ts',kind:'delete'}]}).action,'变更');
  assert.deepEqual(describeFileChanges({changes:[{path:'a.ts',kind:'add'}],files:['a.ts','b.ts']}),{paths:['a.ts','b.ts'],action:'变更',counts:'新增 1 · 变更 1'});
});

test('已有事件展示器支持的图片、Hook、等待和审查事件不被时间线或可见性遗漏', () => {
  for(const type of ['imageView','hookPrompt','sleep','enteredReviewMode','exitedReviewMode']) {
    assert(hasVisibleProcessStep({id:type,type,status:'completed',details:{path:'image.png'}}));
    assert(isProcessTimelineOperationType(type));
  }
  assert(!hasVisibleProcessStep({id:'empty',type:'reasoning',status:'completed',details:{}}));
});
