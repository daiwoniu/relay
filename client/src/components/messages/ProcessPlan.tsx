import Tooltip from '../ui/Tooltip';
import { getProcessPlanTitle, type getProcessPlan } from './process-plan';

function PlanStatusIcon({ status, active }: {
  status: 'pending' | 'inProgress' | 'completed';
  active: boolean;
}) {
  if (status === 'completed') {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.2l2.8 2.8 6.2-6.2" /></svg>;
  }
  if (active) {
    return <svg className="animate-spin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M8 2.5a5.5 5.5 0 015.5 5.5" /></svg>;
  }
  if (status === 'inProgress') {
    return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /><path d="M5.5 8h5" /></svg>;
  }
  return <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5" /></svg>;
}

export default function ProcessPlan({ plan, running, searchTarget = false }: {
  plan: NonNullable<ReturnType<typeof getProcessPlan>>;
  running: boolean;
  searchTarget?: boolean;
}) {
  const title = getProcessPlanTitle(plan, running);
  const progress = plan.entries.length > 0 ? (plan.completed / plan.entries.length) * 100 : 0;
  const completed = plan.completed === plan.entries.length;
  return (
    <section className={`process-plan${completed ? ' process-plan--completed' : ''}${running && !completed ? ' process-plan--running' : ''}`} aria-label="任务计划"
      data-search-target={searchTarget ? `operation:${plan.id}` : undefined}
      data-search-content={searchTarget ? true : undefined}>
      <div className="process-plan__header">
        <Tooltip content={title} asChild><div className="process-plan__title">{title}</div></Tooltip>
        <div className="process-plan__count">{plan.completed}/{plan.entries.length}</div>
      </div>
      <div
        className="process-plan__progress"
        role="progressbar"
        aria-label="计划完成进度"
        aria-valuemin={0}
        aria-valuemax={plan.entries.length}
        aria-valuenow={plan.completed}
      >
        <span style={{ width: `${progress}%` }} />
      </div>
      <ul className="process-plan__list">
        {plan.entries.map((entry, index) => {
          const active = entry.status === 'inProgress' && running;
          const label = entry.status === 'completed' ? '已完成' : active ? '进行中' : entry.status === 'inProgress' ? '未完成' : '待处理';
          return (
            <li key={index} className={`process-plan__step process-plan__step--${entry.status}${active ? ' process-plan__step--active' : ''}`}>
              <span className="process-plan__icon" aria-label={label}><PlanStatusIcon status={entry.status} active={active} /></span>
              <span>{entry.step}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
