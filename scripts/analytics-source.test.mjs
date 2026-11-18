import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyAnalyticsSource,analyticsRelayOrigins} from './lib/analytics-source.mjs';

test('来源状态只保存主机，空值与无法识别区分，不保存路径参数或凭据',()=>{
  assert.deepEqual(classifyAnalyticsSource('https://user:secret@example.test/article?token=secret#private','https://relay.example/tools'),{sourceType:'external',referrerHost:'example.test'});
  assert.deepEqual(classifyAnalyticsSource('','https://relay.example/'),{sourceType:'none',referrerHost:null});
  for(const value of [undefined,'not-a-url','javascript:alert(1)','file:///private'])assert.deepEqual(classifyAnalyticsSource(value,'https://relay.example/'),{referrerHost:null});
});

test('当前和明确配置的Relay入口算站内，其他内网服务及不同端口不猜为站内',()=>{
  const aliases=analyticsRelayOrigins({frontend:{origin:'http://127.0.0.1:9081'},publicAccess:{addresses:[{origin:'https://relay.example:34107'}]}});
  assert.equal(classifyAnalyticsSource('https://relay.example:34107/tools','http://127.0.0.1:9081/news',aliases).sourceType,'internal');
  assert.equal(classifyAnalyticsSource('http://127.0.0.1:9081/tools','https://relay.example:34107/',aliases).sourceType,'internal');
  assert.equal(classifyAnalyticsSource('http://localhost:9081/tools','https://relay.example:34107/',aliases).sourceType,'internal');
  assert.equal(classifyAnalyticsSource('http://[::1]:9081/tools','https://relay.example:34107/',aliases).sourceType,'internal');
  assert.equal(classifyAnalyticsSource('https://current.example/a','https://current.example/b').sourceType,'internal');
  assert.equal(classifyAnalyticsSource('http://192.168.1.2:8080/','http://127.0.0.1:9081/',aliases).sourceType,'external');
  assert.equal(classifyAnalyticsSource('http://127.0.0.1:9090/','http://127.0.0.1:9081/',aliases).sourceType,'external');
  assert.deepEqual(classifyAnalyticsSource('https://[2001:db8::1]/private','https://relay.example/'),{sourceType:'external',referrerHost:'2001:db8::1'});
});

test('默认端口不丢失协议差异，只有明确配置的跨协议入口算站内',()=>{
  assert.deepEqual(classifyAnalyticsSource('http://relay.example:80/','https://relay.example:443/'),{sourceType:'external',referrerHost:'relay.example'});
  assert.equal(classifyAnalyticsSource('https://relay.example:443/a','https://relay.example/b').sourceType,'internal');
  assert.equal(classifyAnalyticsSource('http://relay.example:80/a','http://relay.example/b').sourceType,'internal');
  assert.equal(classifyAnalyticsSource('http://relay.example:80/','https://relay.example:443/',['http://relay.example']).sourceType,'internal');
});
