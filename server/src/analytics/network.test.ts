import assert from 'node:assert/strict';
import test from 'node:test';
import {analyticsNetwork} from './network.js';

test('可信来源按IPv4/IPv6分类，不按访问方式猜测；映射IPv4先归一',()=>{
  for(const ip of ['10.0.0.1','172.16.0.1','172.31.255.255','192.168.1.1','169.254.1.1','fc00::1','fd12::1','fe80::1','::ffff:192.168.1.1'])assert.equal(analyticsNetwork(ip,'public.example'),'internal',ip);
  for(const ip of ['172.15.1.1','172.32.1.1','8.8.8.8','2001:4860:4860::8888'])assert.equal(analyticsNetwork(ip,'127.0.0.1'),'public',ip);
  for(const ip of ['127.0.0.1','::1','::ffff:127.0.0.1']){
    assert.equal(analyticsNetwork(ip,'localhost'),'internal');assert.equal(analyticsNetwork(ip,'127.0.0.1'),'internal');assert.equal(analyticsNetwork(ip,'public.example'),'unknown');assert.equal(analyticsNetwork(ip),'unknown');
  }
  for(const ip of [null,undefined,'local','bad','0.0.0.0','::'])assert.equal(analyticsNetwork(ip,'localhost'),'unknown');
});
