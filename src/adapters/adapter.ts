import type { AppRecord, CatalogApp, Platform, UIScreen, UIFlow } from '../types.js';

export interface AdapterCapabilities {
  platforms: Platform[];
  kinds: string[];
  /** Can run free-text screen search */
  search?: boolean;
  /** Can return ordered flows */
  flows?: boolean;
  /** Can return a whole app's screens by name */
  perApp?: boolean;
  /** Can join on an App Store id (Apple iTunes) */
  byStoreId?: boolean;
  /** Can browse its per-app catalog (search_apps) */
  appSearch?: boolean;
}

export interface SearchQuery {
  query?: string;
  platform?: Platform;
  tags?: string[];
  limit?: number;
}

export interface FlowQuery {
  query?: string;
  app?: string;
  platform?: Platform;
  limit?: number;
}

export interface AppQuery {
  name: string;
  platform?: Platform;
}

export interface AppSearchQuery {
  /** Name substring (live search where the source supports it) */
  query?: string;
  /** App Store category (local catalog) */
  category?: string;
  limit?: number;
}

export interface AppResult {
  app: AppRecord;
  screens: UIScreen[];
  videoUrl?: string;
}

export interface Health {
  ok: boolean;
  note?: string;
}

/**
 * One module per source. Tools fan out over adapters that declare a
 * capability; a failing adapter becomes a `note` in the tool result,
 * never a server crash.
 */
export interface Adapter {
  name: string;
  capabilities: AdapterCapabilities;
  /** 1 cheap request; surfaced in `list_sources`. */
  healthCheck(): Promise<Health>;
  searchScreens?(q: SearchQuery): Promise<UIScreen[]>;
  getFlows?(q: FlowQuery): Promise<UIFlow[]>;
  getApp?(q: AppQuery): Promise<AppResult>;
  byStoreId?(storeId: string, country?: string): Promise<AppResult>;
  searchApps?(q: AppSearchQuery): Promise<CatalogApp[]>;
}

const adapters = new Map<string, Adapter>();

export function registerAdapter(adapter: Adapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapters(): Adapter[] {
  return [...adapters.values()];
}

export function adaptersWith(cap: 'search' | 'flows' | 'perApp' | 'byStoreId' | 'appSearch'): Adapter[] {
  return getAdapters().filter((a) => a.capabilities[cap]);
}

/** Test hook. */
export function __resetAdaptersForTests(): void {
  adapters.clear();
}
