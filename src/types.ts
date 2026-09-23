/** Unified record shapes shared by all adapters (PLAN.md §2). */

export type Kind = 'screen' | 'flow' | 'site' | 'component' | 'store-listing';

export type Platform = 'ios' | 'android' | 'web' | 'desktop' | 'unknown';

export interface AppRecord {
  name: string;
  slug?: string;
  storeId?: string;
  platform: Platform;
  iconUrl?: string;
  storeUrl?: string;
  category?: string;
  rating?: number;
  downloads?: number;
  revenueUsdMonthly?: number;
  paywallType?: string;
  onboardingStepCount?: number;
  version?: string;
}

export interface UIScreen {
  /** `${source}:${nativeId}` */
  id: string;
  source: string;
  kind: Kind;
  platform: Platform;
  app?: { name: string; slug?: string; storeId?: string; logoUrl?: string };
  /** Screen/flow name or AI caption */
  title?: string;
  /** Normalized lowercase tags: screen types, patterns, elements */
  tags: string[];
  /** Remote originals, highest res first */
  imageUrls: string[];
  /** Local file:// paths after download */
  cachedUrls: string[];
  /** Smaller remote image used for inline MCP image blocks */
  thumbnailUrl?: string;
  videoUrl?: string;
  /** hex, when source provides */
  colors?: string[];
  fonts?: string[];
  /** Human-browsable page */
  sourceUrl: string;
  capturedAt?: string;
}

export interface UIFlow extends UIScreen {
  /** Ordered steps */
  steps: UIScreen[];
}

/** Row of the ScreensDesign catalog (api.screensdesign.com/v1/apps/). */
export interface CatalogApp {
  id: number;
  slug: string;
  name: string;
  storeId?: string | null;
  category?: string | null;
  rating?: number | null;
  downloads?: number | null;
  revenue?: number | null;
  paywallType?: string | null;
  onboardingStepCount?: number | null;
  iconUrl?: string | null;
  appstoreLink?: string | null;
}

/** One entry of a Refero facet dictionary (`/v1/*` available endpoints). */
export interface FacetItem {
  id: string;
  name: string;
}

/** Adapter-level failure; tools surface it as a note, never crash. */
export class SourceError extends Error {
  constructor(
    message: string,
    public readonly source: string,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}
