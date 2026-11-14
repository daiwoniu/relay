import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectBasicClientDiagnostics,
  collectClientDiagnostics,
  collectClientEnvironment,
  parseClientEnvironment,
  waitForClientDiagnostics,
  waitForClientEnvironment,
} from './client-environment.ts';

test('解析桌面 Edge、Windows 和 Relay 来源', () => {
  assert.deepEqual(parseClientEnvironment({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36 Edg/140.0.3485.54',
    relayVersion: '0.19.0',
  }), {
    source: 'web', deviceType: 'desktop', osName: 'Windows', osVersion: '10/11',
    browserName: 'Edge', browserVersion: '140.0.3485.54', relayVersion: '0.19.0',
  });
});

test('Client Hints 品牌信息可识别 PWA', () => {
  assert.deepEqual(parseClientEnvironment({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    uaData: { platform: 'Windows', mobile: false, brands: [{ brand: 'Microsoft Edge', version: '140' }] },
    standalone: true,
    relayVersion: '0.19.0',
  }), {
    source: 'pwa', deviceType: 'desktop', osName: 'Windows', osVersion: '10/11',
    browserName: 'Microsoft Edge', browserVersion: '140', relayVersion: '0.19.0',
  });
});

test('识别 Android 手机 Chrome', () => {
  const result = parseClientEnvironment({
    userAgent: 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 Chrome/140.0.7339.51 Mobile Safari/537.36',
    relayVersion: '0.19.0',
  });
  assert.deepEqual(result, {
    source: 'web', deviceType: 'phone', osName: 'Android 兼容环境', osVersion: '16',
    browserName: 'Chrome', browserVersion: '140.0.7339.51', relayVersion: '0.19.0',
  });
});

test('优先识别 UA 中明确暴露的 HarmonyOS 标识', () => {
  assert.deepEqual(parseClientEnvironment({
    userAgent: 'Mozilla/5.0 (Linux; Android 10; HarmonyOS/7.0; Mobile) AppleWebKit/537.36 Chrome/144.0.0.0 Mobile Safari/537.36',
    relayVersion: '0.20.1',
  }), {
    source: 'web', deviceType: 'phone', osName: 'HarmonyOS', osVersion: '7.0',
    browserName: 'Chrome', browserVersion: '144.0.0.0', relayVersion: '0.20.1',
  });
});

test('真实 OpenHarmony UA 优先识别华为浏览器而不是 Chromium 兼容版本', () => {
  const userAgent = 'Mozilla/5.0 (Phone; OpenHarmony 7.0; Android 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36  ArkWeb/7.0.0.104 Mobile HuaweiBrowser/6.1.7.302';
  assert.deepEqual(parseClientEnvironment({
    userAgent,
    uaData: {
      mobile: false,
      brands: [{ brand: 'Google Chrome', version: '144' }],
    },
    navigatorPlatform: 'Linux x86_64',
    maxTouchPoints: 10,
    relayVersion: '0.20.1',
  }), {
    source: 'web', deviceType: 'phone', osName: 'HarmonyOS', osVersion: '7.0',
    browserName: '华为浏览器', browserVersion: '6.1.7.302', relayVersion: '0.20.1',
  });
});

test('桌面 HBPC UA 优先识别华为浏览器而不是内嵌 Chrome 版本', () => {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.84 Safari/537.36 HBPC/12.1.4.300';
  assert.deepEqual(parseClientEnvironment({
    userAgent,
    uaData: {
      mobile: false,
      platform: 'Windows',
      brands: [{ brand: 'Google Chrome', version: '99' }],
    },
    navigatorPlatform: 'Win32',
    relayVersion: '0.26.0',
  }), {
    source: 'web', deviceType: 'desktop', osName: 'Windows', osVersion: '10/11',
    browserName: '华为浏览器', browserVersion: '12.1.4.300', relayVersion: '0.26.0',
  });
});

test('高熵通用 Chrome 品牌也不会覆盖 UA 中明确的华为浏览器', async () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const originalRelayVersion = globalThis.__RELAY_VERSION__;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Mozilla/5.0 (Phone; OpenHarmony 7.0; Android 10) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36 ArkWeb/7.0.0.104 Mobile HuaweiBrowser/6.1.7.302',
      platform: 'Linux x86_64', maxTouchPoints: 10,
      userAgentData: {
        mobile: false,
        async getHighEntropyValues() {
          return { fullVersionList: [{ brand: 'Google Chrome', version: '144.0.0.0' }] };
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { matchMedia: () => ({ matches: false }) },
  });
  globalThis.__RELAY_VERSION__ = '0.20.1';
  try {
    const result = await collectClientEnvironment();
    assert.equal(result.browserName, '华为浏览器');
    assert.equal(result.browserVersion, '6.1.7.302');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    globalThis.__RELAY_VERSION__ = originalRelayVersion;
  }
});

test('明确的 HarmonyOS 版本优先于 Android 兼容层版本', () => {
  const result = parseClientEnvironment({
    userAgent: 'Mozilla/5.0 (Linux; Android 10; HarmonyOS/7.0; Mobile)',
    uaData: { platform: 'Android', platformVersion: '10.0.0' },
    relayVersion: '0.20.1',
  });
  assert.equal(result.osName, 'HarmonyOS');
  assert.equal(result.osVersion, '7.0');
});

test('发送前等待客户端环境，超时则使用基础快照', async () => {
  const fallback = parseClientEnvironment({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    relayVersion: '0.20.1',
  });
  const enriched = { ...fallback, osVersion: '11' };
  assert.equal(await waitForClientEnvironment(Promise.resolve(enriched), fallback, 50), enriched);
  assert.equal(await waitForClientEnvironment(new Promise(() => {}), fallback, 1), fallback);
});

test('高熵 Client Hints 不请求低熵 platform，并可识别 Windows 11', async () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const originalRelayVersion = globalThis.__RELAY_VERSION__;
  let requestedHints;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
      platform: 'Win32',
      maxTouchPoints: 0,
      userAgentData: {
        mobile: false,
        platform: 'Windows',
        brands: [{ brand: 'Microsoft Edge', version: '150' }],
        async getHighEntropyValues(hints) {
          requestedHints = hints;
          return {
            platformVersion: '15.0.0',
            fullVersionList: [{ brand: 'Microsoft Edge', version: '150.0.1000.42' }],
          };
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { matchMedia: () => ({ matches: false }) },
  });
  globalThis.__RELAY_VERSION__ = '0.20.1';

  try {
    const result = await collectClientEnvironment();
    assert.deepEqual(requestedHints, ['platformVersion', 'fullVersionList']);
    assert.equal(result.osName, 'Windows');
    assert.equal(result.osVersion, '11');
    assert.equal(result.browserName, 'Microsoft Edge');
    assert.equal(result.browserVersion, '150.0.1000.42');
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    globalThis.__RELAY_VERSION__ = originalRelayVersion;
  }
});

test('识别使用桌面 UA 的 iPadOS，不误报为手机或 macOS', () => {
  assert.deepEqual(parseClientEnvironment({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    navigatorPlatform: 'MacIntel',
    maxTouchPoints: 5,
    relayVersion: '0.19.0',
  }), {
    source: 'web', deviceType: 'tablet', osName: 'iPadOS',
    browserName: 'Safari', browserVersion: '17.4', relayVersion: '0.19.0',
  });
});

test('浏览器诊断快照只采集明确白名单字段', () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const originalScreen = globalThis.screen;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Mozilla/5.0 HuaweiBrowser/6.1.7 Chrome/144.0.0.0',
      appVersion: '5.0', platform: 'Linux armv8l', vendor: 'Huawei',
      language: 'zh-CN', languages: ['zh-CN', 'zh'], hardwareConcurrency: 8,
      deviceMemory: 12, maxTouchPoints: 10, cookieEnabled: true,
      doNotTrack: '1', webdriver: false, pdfViewerEnabled: true, onLine: true,
      connection: { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false, secret: 'drop' },
      userAgentData: { mobile: true, platform: 'Android', brands: [{ brand: 'Chromium', version: '144' }] },
      secret: 'drop',
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: 420, innerHeight: 850, outerWidth: 420, outerHeight: 900,
      devicePixelRatio: 3, matchMedia: () => ({ matches: false }),
      visualViewport: { width: 420, height: 820, scale: 1, offsetLeft: 0, offsetTop: 0 },
      secret: 'drop',
    },
  });
  Object.defineProperty(globalThis, 'screen', {
    configurable: true,
    value: {
      width: 1260, height: 2720, availWidth: 1260, availHeight: 2650,
      colorDepth: 24, pixelDepth: 24, orientation: { type: 'portrait-primary', angle: 0 },
      secret: 'drop',
    },
  });

  try {
    const result = collectBasicClientDiagnostics();
    assert.equal(result.userAgent.includes('HuaweiBrowser/6.1.7'), true);
    assert.deepEqual(result.languages, ['zh-CN', 'zh']);
    assert.deepEqual(result.userAgentData?.brands, [{ brand: 'Chromium', version: '144' }]);
    assert.equal(result.screen?.width, 1260);
    assert.equal(result.viewport?.visualHeight, 820);
    assert.equal(result.connection?.effectiveType, '4g');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'screen', { configurable: true, value: originalScreen });
  }
});

test('浏览器诊断快照保留可用高熵 Client Hints', async () => {
  const originalNavigator = globalThis.navigator;
  const originalWindow = globalThis.window;
  const originalScreen = globalThis.screen;
  let requestedHints;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: 'Mozilla/5.0 Chrome/144.0.0.0', appVersion: '5.0', platform: 'Linux',
      maxTouchPoints: 0, onLine: true,
      userAgentData: {
        mobile: true, platform: 'Android', brands: [{ brand: 'Chromium', version: '144' }],
        async getHighEntropyValues(hints) {
          requestedHints = hints;
          return {
            architecture: 'arm', bitness: '64', model: 'HUAWEI', platformVersion: '10.0.0',
            fullVersionList: [{ brand: 'Chromium', version: '144.0.1.2' }], wow64: false,
          };
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 420, innerHeight: 850, devicePixelRatio: 3, matchMedia: () => ({ matches: false }) },
  });
  Object.defineProperty(globalThis, 'screen', { configurable: true, value: { width: 1260, height: 2720 } });

  try {
    const result = await collectClientDiagnostics();
    assert.equal(requestedHints.includes('model'), true);
    assert.equal(result.userAgentData?.highEntropy?.model, 'HUAWEI');
    assert.deepEqual(result.userAgentData?.highEntropy?.fullVersionList, [{ brand: 'Chromium', version: '144.0.1.2' }]);
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: originalNavigator });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'screen', { configurable: true, value: originalScreen });
  }
});

test('发送前等待浏览器诊断快照，超时保留本次同步基础快照', async () => {
  const fallback = { capturedAt: 123, userAgent: 'basic', standalone: false };
  const enriched = { ...fallback, userAgentData: { highEntropy: { model: 'HUAWEI' } } };
  assert.equal(await waitForClientDiagnostics(Promise.resolve(enriched), fallback, 50), enriched);
  assert.equal(await waitForClientDiagnostics(new Promise(() => {}), fallback, 1), fallback);
});
