export interface NewsItemInput {
  id: string;
  eventId: string;
  sourceId: string;
  url: string;
  title: string;
  description: string | null;
  publishedAt: number;
  firstFetchedAt: number;
  categoryId: string;
  topicIds: string[];
  entityIds: string[];
  eventTypeId: string | null;
  language: string | null;
  originalPublisher?: string | null;
  timeIsFallback?: boolean;
}

export interface NewsEvent extends NewsItemInput {
  sources: NewsItemInput[];
}

export interface NewsPage {
  items: NewsEvent[];
  nextCursor: string | null;
  version: number;
}

export interface NewsFilters {
  category?: string;
  topic?: string;
  entity?: string;
  eventType?: string;
  source?: string;
  sourceIds?: string[];
  language?: string;
  q?: string;
}

export interface NewsStorageStatus {
  available: boolean;
  error: string | null;
  version: number;
  lastSuccessAt: number | null;
  loadedShards: string[];
}

export interface NewsSourceState {
  sourceId: string;
  lastSuccessAt: number | null;
  lastCheckedAt: number | null;
  nextFetchAt: number | null;
  etag: string | null;
  lastModified: string | null;
  lastError: string | null;
  failureCount: number;
  lastDurationMs: number | null;
  lastFetchedCount: number | null;
}
