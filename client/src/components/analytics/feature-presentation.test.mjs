import test from 'node:test';
import assert from 'node:assert/strict';
import {loadTsxForTest} from '../ui/tsx-test-helper.mjs';
const {detailQuery,emptyDetailFilter,featureTotals,actionLabel,actionsForFeature}=await loadTsxForTest(new URL('./feature-presentation.ts',import.meta.url).href);
test('明细联动保持全局筛选，并按功能动作结果在服务端查询',()=>{
 const params=new URLSearchParams(detailQuery('range=today&excludeAdmin=true',{...emptyDetailFilter,feature:'tool.qr',action:'pin',result:'error'},{at:123,id:'abc'}));
 assert.equal(params.get('range'),'today');assert.equal(params.get('excludeAdmin'),'true');assert.equal(params.get('feature'),'tool.qr');assert.equal(params.get('includeSystem'),'false');assert.equal(params.get('beforeAt'),'123');
 const reset=new URLSearchParams(detailQuery('range=all',emptyDetailFilter));assert.equal(reset.has('beforeAt'),false);assert.equal(reset.has('feature'),false);
});
test('失败概览包含本地操作失败，取消与业务结果不累加为操作次数',()=>{
 assert.deepEqual(featureTotals({features:[{feature:'file_preview',views:1,actions:3,failures:2,results:{error:1,cancelled:8}}],operations:[]}),{actions:3,errors:2});
 assert.deepEqual(featureTotals(null),{actions:0,errors:0});assert.match(actionLabel('tools.pin','pin'),/置顶/);
});
test('功能筛选收窄动作选项，并保留资讯及工具兼容动作',()=>{
 assert.ok(actionsForFeature('settings').includes('save'));
 assert.equal(actionsForFeature('settings').includes('format'),false);
 assert.equal(actionsForFeature('settings').includes('run'),false);
 assert.ok(actionsForFeature('news').includes('read'));
 assert.ok(actionsForFeature('tool.json').includes('format'));
 assert.ok(actionsForFeature('tool.json').includes('pin'));
 assert.ok(actionsForFeature('').length>actionsForFeature('settings').length);
});
