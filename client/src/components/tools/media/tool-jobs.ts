import { createContext } from 'react';
import type { MediaToolId } from '../../../../../server/src/analytics/registry.ts';

export const MediaJobsContext = createContext<Set<AbortController> | null>(null);
export const MediaToolContext = createContext<MediaToolId | null>(null);
