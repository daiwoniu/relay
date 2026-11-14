import type { ClientDiagnosticsDto, ClientEnvironmentDto } from '../generated/relay-contracts';

interface NavigatorUAData {
  mobile?: boolean;
  platform?: string;
  platformVersion?: string;
  brands?: Array<{ brand: string; version: string }>;
  getHighEntropyValues?: (hints: string[]) => Promise<{
    architecture?: string;
    bitness?: string;
    formFactors?: string[];
    model?: string;
    platformVersion?: string;
    uaFullVersion?: string;
    wow64?: boolean;
    fullVersionList?: Array<{ brand: string; version: string }>;
  }>;
}

interface NavigatorConnection {
  type?: string;
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

type DiagnosticNavigator = Navigator & {
  userAgentData?: NavigatorUAData;
  standalone?: boolean;
  deviceMemory?: number;
  connection?: NavigatorConnection;
};

export interface ClientEnvironmentInput {
  userAgent: string;
  uaData?: NavigatorUAData;
  navigatorPlatform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  relayVersion: string;
}

function cleanVersion(value: string | undefined): string | undefined {
  return value?.replace(/_/g, '.').trim() || undefined;
}

function boundedString(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value ? value.slice(0, max) : undefined;
}

function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function boundedBrands(value: Array<{ brand: string; version: string }> | undefined) {
  if (!Array.isArray(value)) return undefined;
  const brands = value.slice(0, 20).flatMap((entry) => {
    const brand = boundedString(entry?.brand, 128);
    const version = boundedString(entry?.version, 128);
    return brand !== undefined && version !== undefined ? [{ brand, version }] : [];
  });
  return brands.length ? brands : undefined;
}

function standaloneMode(nav: DiagnosticNavigator): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches === true || nav.standalone === true;
}

export function collectBasicClientDiagnostics(): ClientDiagnosticsDto {
  const nav = navigator as DiagnosticNavigator;
  const visualViewport = window.visualViewport;
  const connection = nav.connection;
  let timezone: string | undefined;
  try { timezone = boundedString(Intl.DateTimeFormat().resolvedOptions().timeZone, 128); } catch {}
  const languages = Array.isArray(nav.languages)
    ? nav.languages.slice(0, 20).flatMap((entry) => boundedString(entry, 64) || [])
    : undefined;
  const brands = boundedBrands(nav.userAgentData?.brands);
  const orientation = screen.orientation;
  return {
    capturedAt: Date.now(),
    userAgent: nav.userAgent.slice(0, 4096),
    ...(boundedString(nav.appVersion, 4096) ? { appVersion: boundedString(nav.appVersion, 4096) } : {}),
    ...(boundedString(nav.platform, 128) ? { platform: boundedString(nav.platform, 128) } : {}),
    ...(boundedString(nav.vendor, 128) ? { vendor: boundedString(nav.vendor, 128) } : {}),
    ...(boundedString(nav.language, 64) ? { language: boundedString(nav.language, 64) } : {}),
    ...(languages?.length ? { languages } : {}),
    ...(timezone ? { timezone } : {}),
    ...(boundedNumber(nav.hardwareConcurrency, 1, 1024) ? { hardwareConcurrency: nav.hardwareConcurrency } : {}),
    ...(boundedNumber(nav.deviceMemory, Number.MIN_VALUE, 1024) ? { deviceMemory: nav.deviceMemory } : {}),
    ...(boundedNumber(nav.maxTouchPoints, 0, 100) !== undefined ? { maxTouchPoints: nav.maxTouchPoints } : {}),
    ...(typeof nav.cookieEnabled === 'boolean' ? { cookieEnabled: nav.cookieEnabled } : {}),
    ...(boundedString(nav.doNotTrack, 32) ? { doNotTrack: boundedString(nav.doNotTrack, 32) } : {}),
    ...(typeof nav.webdriver === 'boolean' ? { webdriver: nav.webdriver } : {}),
    ...(typeof nav.pdfViewerEnabled === 'boolean' ? { pdfViewerEnabled: nav.pdfViewerEnabled } : {}),
    standalone: standaloneMode(nav),
    ...(typeof nav.onLine === 'boolean' ? { online: nav.onLine } : {}),
    ...((brands || typeof nav.userAgentData?.mobile === 'boolean' || boundedString(nav.userAgentData?.platform, 128)) ? {
      userAgentData: {
        ...(typeof nav.userAgentData?.mobile === 'boolean' ? { mobile: nav.userAgentData.mobile } : {}),
        ...(boundedString(nav.userAgentData?.platform, 128) ? { platform: boundedString(nav.userAgentData?.platform, 128) } : {}),
        ...(brands ? { brands } : {}),
      },
    } : {}),
    screen: {
      ...(boundedNumber(screen.width, 0, 100_000) !== undefined ? { width: screen.width } : {}),
      ...(boundedNumber(screen.height, 0, 100_000) !== undefined ? { height: screen.height } : {}),
      ...(boundedNumber(screen.availWidth, 0, 100_000) !== undefined ? { availWidth: screen.availWidth } : {}),
      ...(boundedNumber(screen.availHeight, 0, 100_000) !== undefined ? { availHeight: screen.availHeight } : {}),
      ...(boundedNumber(screen.colorDepth, 0, 1024) !== undefined ? { colorDepth: screen.colorDepth } : {}),
      ...(boundedNumber(screen.pixelDepth, 0, 1024) !== undefined ? { pixelDepth: screen.pixelDepth } : {}),
      ...(boundedNumber(window.devicePixelRatio, Number.MIN_VALUE, 100) ? { devicePixelRatio: window.devicePixelRatio } : {}),
      ...(boundedString(orientation?.type, 64) ? { orientationType: boundedString(orientation?.type, 64) } : {}),
      ...(boundedNumber(orientation?.angle, -360, 360) !== undefined ? { orientationAngle: orientation.angle } : {}),
    },
    viewport: {
      ...(boundedNumber(window.innerWidth, 0, 100_000) !== undefined ? { width: window.innerWidth } : {}),
      ...(boundedNumber(window.innerHeight, 0, 100_000) !== undefined ? { height: window.innerHeight } : {}),
      ...(boundedNumber(window.outerWidth, 0, 100_000) !== undefined ? { outerWidth: window.outerWidth } : {}),
      ...(boundedNumber(window.outerHeight, 0, 100_000) !== undefined ? { outerHeight: window.outerHeight } : {}),
      ...(boundedNumber(visualViewport?.width, 0, 100_000) !== undefined ? { visualWidth: visualViewport?.width } : {}),
      ...(boundedNumber(visualViewport?.height, 0, 100_000) !== undefined ? { visualHeight: visualViewport?.height } : {}),
      ...(boundedNumber(visualViewport?.scale, Number.MIN_VALUE, 100) ? { visualScale: visualViewport?.scale } : {}),
      ...(boundedNumber(visualViewport?.offsetLeft, -100_000, 100_000) !== undefined ? { visualOffsetLeft: visualViewport?.offsetLeft } : {}),
      ...(boundedNumber(visualViewport?.offsetTop, -100_000, 100_000) !== undefined ? { visualOffsetTop: visualViewport?.offsetTop } : {}),
    },
    ...(connection ? { connection: {
      ...(boundedString(connection.type, 32) ? { type: boundedString(connection.type, 32) } : {}),
      ...(boundedString(connection.effectiveType, 32) ? { effectiveType: boundedString(connection.effectiveType, 32) } : {}),
      ...(boundedNumber(connection.downlink, 0, 1_000_000) !== undefined ? { downlink: connection.downlink } : {}),
      ...(boundedNumber(connection.rtt, 0, 3_600_000) !== undefined ? { rtt: connection.rtt } : {}),
      ...(typeof connection.saveData === 'boolean' ? { saveData: connection.saveData } : {}),
    } } : {}),
  };
}

export async function collectClientDiagnostics(
  base = collectBasicClientDiagnostics(),
): Promise<ClientDiagnosticsDto> {
  const uaData = (navigator as DiagnosticNavigator).userAgentData;
  try {
    const highEntropy = await uaData?.getHighEntropyValues?.([
      'architecture', 'bitness', 'formFactors', 'fullVersionList', 'model',
      'platformVersion', 'uaFullVersion', 'wow64',
    ]);
    if (!highEntropy) return base;
    const formFactors = Array.isArray(highEntropy.formFactors)
      ? highEntropy.formFactors.slice(0, 20).flatMap((entry) => boundedString(entry, 64) || [])
      : undefined;
    const normalizedHighEntropy = {
      ...(boundedString(highEntropy.architecture, 64) ? { architecture: boundedString(highEntropy.architecture, 64) } : {}),
      ...(boundedString(highEntropy.bitness, 32) ? { bitness: boundedString(highEntropy.bitness, 32) } : {}),
      ...(formFactors?.length ? { formFactors } : {}),
      ...(boundedBrands(highEntropy.fullVersionList) ? { fullVersionList: boundedBrands(highEntropy.fullVersionList) } : {}),
      ...(boundedString(highEntropy.model, 256) ? { model: boundedString(highEntropy.model, 256) } : {}),
      ...(boundedString(highEntropy.platformVersion, 128) ? { platformVersion: boundedString(highEntropy.platformVersion, 128) } : {}),
      ...(boundedString(highEntropy.uaFullVersion, 128) ? { uaFullVersion: boundedString(highEntropy.uaFullVersion, 128) } : {}),
      ...(typeof highEntropy.wow64 === 'boolean' ? { wow64: highEntropy.wow64 } : {}),
    };
    return {
      ...base,
      userAgentData: { ...(base.userAgentData || {}), highEntropy: normalizedHighEntropy },
    };
  } catch {
    return base;
  }
}

function chromiumBrand(brands: Array<{ brand: string; version: string }> | undefined) {
  return brands?.find((item) => !/not.?a.?brand|chromium/i.test(item.brand));
}

function parseBrowser(userAgent: string): Pick<ClientEnvironmentDto, 'browserName' | 'browserVersion'> {
  const patterns: Array<[RegExp, string]> = [
    [/(?:HuaweiBrowser|HBPC)\/([\d.]+)/i, '华为浏览器'],
    [/EdgA?\/([\d.]+)/, 'Edge'],
    [/EdgiOS\/([\d.]+)/, 'Edge'],
    [/OPR\/([\d.]+)/, 'Opera'],
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

function parseOs(userAgent: string, platform?: string, platformVersion?: string) {
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
  const harmony = /(?:HarmonyOS|OpenHarmony(?:OS)?)[\s/]([\d._]+)/i.exec(userAgent);
  if (/HarmonyOS|OpenHarmony/i.test(platform || '') || harmony) {
    const osVersion = cleanVersion(harmony?.[1]) || cleanVersion(platformVersion);
    return { osName: 'HarmonyOS', ...(osVersion ? { osVersion } : {}) };
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

export function parseClientEnvironment(input: ClientEnvironmentInput): ClientEnvironmentDto {
  const desktopIpad = input.navigatorPlatform === 'MacIntel' && (input.maxTouchPoints || 0) > 1;
  const tablet = desktopIpad || /iPad|Tablet/i.test(input.userAgent)
    || (/Android/i.test(input.userAgent) && !/Mobile/i.test(input.userAgent));
  const phone = !desktopIpad && (input.uaData?.mobile === true || /Mobile|iPhone|Android.*Mobile/i.test(input.userAgent));
  const brand = chromiumBrand(input.uaData?.brands);
  const parsedBrowser = parseBrowser(input.userAgent);
  const explicitHuaweiBrowser = /(?:HuaweiBrowser|HBPC)\/[\d.]+/i.test(input.userAgent);
  return {
    source: input.standalone ? 'pwa' : 'web',
    deviceType: tablet ? 'tablet' : phone ? 'phone' : 'desktop',
    ...(desktopIpad
      ? { osName: 'iPadOS' }
      : parseOs(input.userAgent, input.uaData?.platform, input.uaData?.platformVersion)),
    ...(explicitHuaweiBrowser || !brand
      ? parsedBrowser
      : { browserName: brand.brand, browserVersion: cleanVersion(brand.version) }),
    relayVersion: input.relayVersion,
  };
}

export function collectBasicClientEnvironment(): ClientEnvironmentDto {
  const navigatorWithHints = navigator as Navigator & { userAgentData?: NavigatorUAData; standalone?: boolean };
  const standalone = standaloneMode(navigatorWithHints);
  return parseClientEnvironment({
    userAgent: navigator.userAgent,
    uaData: navigatorWithHints.userAgentData,
    navigatorPlatform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    standalone,
    relayVersion: __RELAY_VERSION__,
  });
}

export async function collectClientEnvironment(): Promise<ClientEnvironmentDto> {
  const navigatorWithHints = navigator as Navigator & { userAgentData?: NavigatorUAData };
  const base = collectBasicClientEnvironment();
  try {
    const highEntropy = await navigatorWithHints.userAgentData?.getHighEntropyValues?.([
      'platformVersion', 'fullVersionList',
    ]);
    if (!highEntropy) return base;
    const brand = chromiumBrand(highEntropy.fullVersionList);
    return {
      ...base,
      ...(base.osName === 'iPadOS'
        ? { osName: 'iPadOS' }
        : parseOs(navigator.userAgent, navigatorWithHints.userAgentData?.platform, highEntropy.platformVersion)),
      ...(base.browserName === '华为浏览器'
        ? {}
        : brand ? { browserName: brand.brand, browserVersion: cleanVersion(brand.version) } : {}),
    };
  } catch {
    return base;
  }
}

export async function waitForClientEnvironment(
  pending: Promise<ClientEnvironmentDto> | null,
  fallback: ClientEnvironmentDto,
  timeoutMs = 1_000,
): Promise<ClientEnvironmentDto> {
  if (!pending) return fallback;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    void pending.then(
      (environment) => {
        clearTimeout(timer);
        resolve(environment);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export async function waitForClientDiagnostics(
  pending: Promise<ClientDiagnosticsDto> | null,
  fallback: ClientDiagnosticsDto,
  timeoutMs = 1_000,
): Promise<ClientDiagnosticsDto> {
  if (!pending) return fallback;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    void pending.then(
      (diagnostics) => {
        clearTimeout(timer);
        resolve(diagnostics);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}
