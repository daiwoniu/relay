export function cleanVersion(value) {
  return value?.replace(/_/g, '.').trim() || undefined;
}
export function chromiumBrand(brands) {
  return brands?.find((item) => !/not.?a.?brand|chromium/i.test(item.brand));
}

function parseBrowser(userAgent) {
  const patterns = [
    [/MicroMessenger\/([\d.]+)/i, '微信内置浏览器'],
    [/(?:HuaweiBrowser|HBPC)\/([\d.]+)/i, '华为浏览器'],
    [/MiuiBrowser\/([\d.]+)/i, '小米浏览器'],
    [/(?:MQQBrowser|QQBrowser)\/([\d.]+)/i, 'QQ浏览器'],
    [/(?:UCBrowser|UCWEB)\/([\d.]+)/i, 'UC浏览器'],
    [/Quark\/([\d.]+)/i, '夸克浏览器'],
    [/SamsungBrowser\/([\d.]+)/i, 'Samsung Internet'],
    [/EdgA?\/([\d.]+)/, 'Edge'],
    [/EdgiOS\/([\d.]+)/, 'Edge'],
    [/(?:OPR|OPiOS)\/([\d.]+)/i, 'Opera'],
    [/CriOS\/([\d.]+)/, 'Chrome'],
    [/Chrome\/([\d.]+)/, 'Chrome'],
    [/FxiOS\/([\d.]+)/, 'Firefox'],
    [/Firefox\/([\d.]+)/, 'Firefox'],
    [/Version\/([\d.]+).*Safari\//, 'Safari'],
  ];
  for (const [pattern, browserName] of patterns) {
    const match = pattern.exec(userAgent);
    if (match) return { browserName, browserVersion: cleanVersion(match[1]) };
  }
  return {};
}

export function explicitBrowser(name){
  return ['微信内置浏览器','华为浏览器','小米浏览器','QQ浏览器','UC浏览器','夸克浏览器','Samsung Internet','Opera'].includes(name??'');
}

export function parseOs(userAgent, platform, platformVersion) {
  const harmony = /(?:HarmonyOS|OpenHarmony(?:OS)?)[\s/]([\d._]+)/i.exec(userAgent);
  if (/HarmonyOS|OpenHarmony/i.test(platform || '') || /(?:^|[ (;])(?:HarmonyOS|OpenHarmony(?:OS)?)(?:[\s/;)]|$)/i.test(userAgent)) {
    // A compatibility platform version may describe Android rather than HarmonyOS.
    const osVersion = cleanVersion(harmony?.[1]) || (/HarmonyOS|OpenHarmony/i.test(platform??'')?cleanVersion(platformVersion):undefined);
    return { osName: 'HarmonyOS', ...(osVersion ? { osVersion } : {}) };
  }
  if (/Windows/i.test(platform || '') || /Windows NT/i.test(userAgent)) {
    let osVersion = cleanVersion(platformVersion);
    if (osVersion) {
      const major = Number(osVersion.split('.')[0]);
      if (Number.isFinite(major)) osVersion = major >= 13 ? '11' : '10';
    } else {
      const match = /Windows NT ([\d.]+)/.exec(userAgent);
      const legacy = match?.[1];
      osVersion = legacy === '10.0' ? '10/11' : cleanVersion(legacy);
    }
    return { osName: 'Windows', ...(osVersion ? { osVersion } : {}) };
  }
  for(const osName of ['HyperOS','MIUI']){
    const marker=new RegExp(`(?:^|[ (;])${osName}(?=[\\s/;)]|$)(?:[\\s/]+v?([\\d._]+))?`,'i').exec(userAgent);
    if(marker){const osVersion=cleanVersion(marker[1]);return{osName,...(osVersion?{osVersion}:{})};}
  }
  const android = /Android\s+([\d._]+)/i.exec(userAgent);
  if (/Android/i.test(platform || '') || android) {
    const osVersion = cleanVersion(platformVersion) || cleanVersion(android?.[1]);
    return { osName: 'Android 兼容环境', ...(osVersion ? { osVersion } : {}) };
  }
  const ios = /(?:CPU (?:iPhone )?OS|iPhone OS)\s*([\d_]+)/i.exec(userAgent);
  if (/iOS/i.test(platform || '') || ios) {
    const osVersion = cleanVersion(platformVersion) || cleanVersion(ios?.[1]);
    return { osName: 'iOS', ...(osVersion ? { osVersion } : {}) };
  }
  const mac = /Mac OS X\s*([\d_]+)/i.exec(userAgent);
  if (/macOS/i.test(platform || '') || mac) {
    const osVersion = cleanVersion(platformVersion) || cleanVersion(mac?.[1]);
    return { osName: 'macOS', ...(osVersion ? { osVersion } : {}) };
  }
  if (/Linux/i.test(platform || '') || /Linux/i.test(userAgent)) return { osName: 'Linux' };
  return {};
}

export function parseClientEnvironment(input) {
  const desktopIpad = input.navigatorPlatform === 'MacIntel' && (input.maxTouchPoints || 0) > 1;
  const phoneMarker=/Mobile|iPhone|\bPhone\b/i.test(input.userAgent);
  const tablet = desktopIpad || /iPad|Tablet/i.test(input.userAgent)
    || (/Android/i.test(input.userAgent) && !phoneMarker);
  const phone = !desktopIpad && (input.uaData?.mobile === true || phoneMarker);
  const brand = chromiumBrand(input.uaData?.brands);
  const parsedBrowser = parseBrowser(input.userAgent);
  return {
    source: input.standalone ? 'pwa' : 'web',
    deviceType: tablet ? 'tablet' : phone ? 'phone' : 'desktop',
    ...(desktopIpad
      ? { osName: 'iPadOS' }
      : parseOs(input.userAgent, input.uaData?.platform, input.uaData?.platformVersion)),
    ...(explicitBrowser(parsedBrowser.browserName) || !brand
      ? parsedBrowser
      : { browserName: brand.brand, browserVersion: cleanVersion(brand.version) }),
    relayVersion: input.relayVersion,
  };
}

export function normalizeAnalyticsEnvironment(e) {
  const specific={'微信内置浏览器':'WeChat','华为浏览器':'Huawei','小米浏览器':'Xiaomi','QQ浏览器':'QQ','UC浏览器':'UC','夸克浏览器':'Quark','Samsung Internet':'Samsung','Opera':'Opera'};
  const browser=specific[e.browserName??'']??(/edge/i.test(e.browserName??'')?'Edge':/firefox/i.test(e.browserName??'')?'Firefox':/wechat|微信/i.test(e.browserName??'')?'WeChat':/chrome/i.test(e.browserName??'')?'Chrome':/safari/i.test(e.browserName??'')?'Safari':'Other');
  const osName=e.osName==='Android 兼容环境'?'Android':e.osName;
  const os=['Windows','Android','HarmonyOS','HyperOS','MIUI','iOS','iPadOS','macOS','Linux'].includes(osName??'')?osName:'Other';
  const device=e.deviceType==='phone'?'mobile':['desktop','mobile','tablet'].includes(e.deviceType??'')?e.deviceType:'unknown';
  return{device,browser,os};
}
