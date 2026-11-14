import type { NewsFilters, NewsItemInput } from '../types.js';

// Corrections live in news.db, so these dimensions must be checked after loading a shard row.
export function shardFilters(filters: NewsFilters): NewsFilters {
  const { source, sourceIds, language, q } = filters;
  return { source, sourceIds, language, q };
}

export function matchesVisibleFilters(item: NewsItemInput, filters: NewsFilters): boolean {
  return (!filters.category || item.categoryId === filters.category)
    && (!filters.sourceIds || filters.sourceIds.includes(item.sourceId))
    && (!filters.topic || item.topicIds.includes(filters.topic))
    && (!filters.entity || item.entityIds.includes(filters.entity))
    && (!filters.eventType || item.eventTypeId === filters.eventType);
}
