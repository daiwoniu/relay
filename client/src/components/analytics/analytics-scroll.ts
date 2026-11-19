// Only scroll the analytics viewport. scrollIntoView can also move clipped app ancestors.
export function scrollAnalyticsIntoView(target:HTMLElement|null){
  const viewport=target?.closest<HTMLElement>('.analytics-scroll');
  if(!target||!viewport)return;
  const top=viewport.scrollTop+target.getBoundingClientRect().top-viewport.getBoundingClientRect().top-viewport.clientTop-16;
  viewport.scrollTo({top:Math.max(0,top),behavior:globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
}
