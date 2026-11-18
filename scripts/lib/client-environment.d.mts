import type { ClientEnvironmentDto } from '../../server/src/contracts/dto.js';
import type { AnalyticsEvent } from '../../server/src/analytics/contract.js';
export interface NavigatorUAData {
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

export interface ClientEnvironmentInput {
  userAgent: string;
  uaData?: NavigatorUAData;
  navigatorPlatform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  relayVersion: string;
}

export function cleanVersion(value: string | undefined): string | undefined;
export function chromiumBrand(brands: NavigatorUAData['brands']): {brand:string;version:string} | undefined;
export function explicitBrowser(name?:string): boolean;
export function parseOs(userAgent:string,platform?:string,platformVersion?:string): Pick<ClientEnvironmentDto,'osName'|'osVersion'>;
export function parseClientEnvironment(input:ClientEnvironmentInput): ClientEnvironmentDto;
export function normalizeAnalyticsEnvironment(input:{deviceType?:string;browserName?:string;osName?:string}): Pick<AnalyticsEvent,'device'|'browser'|'os'>;
