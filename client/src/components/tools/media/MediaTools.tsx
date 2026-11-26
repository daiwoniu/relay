import type { MediaToolId } from '../../../../../server/src/analytics/registry.ts';
import { lazy, type ComponentType } from 'react';
import { MediaJobsContext, MediaToolContext } from './tool-jobs';

const panels: Record<MediaToolId, ComponentType<{ storageKey: string }>> = {
  'image-edit': lazy(() => import('./ImageTools').then(({ ImageEdit }) => ({ default: ImageEdit }))),
  'image-stitch': lazy(() => import('./ImageTools').then(({ ImageStitch }) => ({ default: ImageStitch }))),
  'image-layout': lazy(() => import('./ImageTools').then(({ ImageLayout }) => ({ default: ImageLayout }))),
  'audio-edit': lazy(() => import('./AudioTools').then(({ AudioEdit }) => ({ default: AudioEdit }))),
  'tone-generator': lazy(() => import('./AudioTools').then(({ ToneGenerator }) => ({ default: ToneGenerator }))),
  'subtitle-edit': lazy(() => import('./SubtitleTool')),
  'image-motion': lazy(() => import('./VideoTools').then(({ ImageMotion }) => ({ default: ImageMotion }))),
  'video-edit': lazy(() => import('./VideoTools').then(({ VideoEdit }) => ({ default: VideoEdit }))),
};

export default function MediaTools({ id, storageKey, jobs }: { id: MediaToolId; storageKey: string; jobs: Set<AbortController> }) {
  const Panel = panels[id];
  return <MediaJobsContext.Provider value={jobs}>
    <MediaToolContext.Provider value={id}><Panel storageKey={storageKey} /></MediaToolContext.Provider>
  </MediaJobsContext.Provider>;
}
