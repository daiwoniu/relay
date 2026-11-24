import type { ToolId } from './tools-state';

const drawings: Record<ToolId, string> = {
  news: 'M4 5h13v14H6a2 2 0 0 1-2-2V5Zm13 3h3v9a2 2 0 0 1-2 2h-1M7 8h3v3H7zM12 9h2M7 14h7M7 16.5h7',
  calendar: 'M4 6h16v14H4zM8 4v4m8-4v4M4 10h16m-12 3h1m3 0h1m3 0h1m-9 3h1m3 0h1',
  weather: 'M7 13a4 4 0 1 1 6-5m-3-4V2M4.5 5l-1-1M3 10H1m15-6 1.5-1.5M8 18.5a3 3 0 1 1 .4-6 4.5 4.5 0 0 1 8.5.5 2.8 2.8 0 1 1 1.1 5.5H8Z',
  greeting: 'M4 5h16v11h-9l-5 4v-4H4zM8 10h.01M12 10h.01M16 10h.01',
  timestamp: 'M20 12a8 8 0 1 1-3.4-6.55M12 7v5l3 2m2-10v4h4',
  json: 'M8 4H7c-1.3 0-2 1-2 2.5V10c0 1-.5 2-2 2 1.5 0 2 1 2 2v3.5C5 19 5.7 20 7 20h1m8-16h1c1.3 0 2 1 2 2.5V10c0 1 .5 2 2 2-1.5 0-2 1-2 2v3.5c0 1.5-.7 2.5-2 2.5h-1M10 9h4m-4 6h4',
  qr: 'M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 0h3v3h3v3h-6m6-6v1M7 7h.01M17 7h.01M7 17h.01',
  diff: 'M4 5h6v14H4zm10 0h6v14h-6zM6 12h2m8 0h2m-1-1v2',
  pomodoro: 'M17.8 15a6.8 6.8 0 1 1-1.2-7.3M10 3h4m-2 0v3m0 4v3l2 1m4-7 1.5-1.5',
  units: 'm4 15 11-11 5 5-11 11zM13 6l2 2m-5 1 1.4 1.4M7 12l2 2',
  dates: 'M4 6h16v14H4zM8 4v4m8-4v4M4 10h16m-11 5h6m-2-2 2 2-2 2',
  shopping: 'M4 6h2l1.6 8.3a1 1 0 0 0 1 .7h8.7a1 1 0 0 0 1-.7L20 8H6.4M9 19h.01M17 19h.01M13 10v3m-1.5-1.5h3',
  random: 'M6 4h12l2 2v12l-2 2H6l-2-2V6zM8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01',
  'image-edit': 'M8 3v13h13M3 8h13v13m-5-8 2-2m3-3 4-4',
  'image-stitch': 'M4 4h16v7H4zm0 9h16v7H4zm3-5h.01M7 17h.01m3-8 2-2 3 3m-5 9 2-3 4 4',
  'image-layout': 'M4 4h16v16H4zM7 8h10M7 11h6m-6 3h5v3H7zm8 0h2m-2 3h2',
  'audio-edit': 'M3 12h2l2-5 3 10 3-12 3 13 2-6h3',
  'subtitle-edit': 'M3 5h18v14H3zm3 8h4m3 0h5M6 16h7m3 0h2',
  'image-motion': 'M14 19H4V5h16v7M7 8.5h.01M5 16l4-4 3 3m3-2 6 3.5-6 3.5z',
  'video-edit': 'M4 10h16v10H4zm0 0L3 6l15-3 1 4-15 3Zm3-5 2 4m3-5 2 4',
  'tone-generator': 'M6 16c1.4-1.1 2-2.7 2-5a4 4 0 0 1 8 0c0 2.3.6 3.9 2 5H6Zm4 3a2 2 0 0 0 4 0M4 10c0-1.2.5-2.7 1.5-3.5M20 10c0-1.2-.5-2.7-1.5-3.5',
};

export default function ToolIcon({ id }: { id: ToolId }) {
  return <svg aria-hidden="true" focusable="false" width="24" height="24" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d={drawings[id]} />
  </svg>;
}
