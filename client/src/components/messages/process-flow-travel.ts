import type { getFlowTravelRoute } from './process-flow-time';

type Route = NonNullable<ReturnType<typeof getFlowTravelRoute>>;

/** Keep an emitted light on its route until the animation reaches its end. */
export function createFlowTravelController(view: {
  measure: (targetId: string) => Route | null;
  show: (route: Route) => void;
  hide: () => void;
}) {
  let target: string | undefined;
  let flyingTo: string | undefined;
  let enabled = false;
  const start = () => {
    if (!enabled || !target || flyingTo) return;
    const route = view.measure(target);
    if (!route) return;
    flyingTo = target;
    view.show(route);
  };
  return {
    update(nextTarget: string | undefined, motion: boolean) {
      target = nextTarget;
      enabled = motion;
      start();
    },
    finish() {
      flyingTo = undefined;
      start();
      if (!flyingTo) view.hide();
    },
    refresh() {
      if (!flyingTo) { start(); return; }
      const route = view.measure(flyingTo);
      if (route) view.show(route);
    },
    reset() {
      flyingTo = undefined;
      view.hide();
    },
  };
}
