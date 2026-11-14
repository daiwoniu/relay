import type { ProcessStep, ProcessTimelineEntry } from '../../stores/chat';
import { isCollabAgentSubtask } from './collab-agent-step.ts';

export type ProcessNarrativeStatus = 'in_progress' | 'completed' | 'stopped';

export function getProcessNarrativeStatus(timeline: ProcessTimelineEntry[], itemId: string, settled: boolean, status: ProcessNarrativeStatus = settled ? 'completed' : 'in_progress'): ProcessNarrativeStatus {
  const last = timeline[timeline.length - 1];
  return settled || last?.type === 'narrative' && last.itemId === itemId ? status : 'completed';
}

export type ProcessExecutionSection =
  | { type: 'operations'; key: string; steps: ProcessStep[] }
  | { type: 'subtask'; key: string; step: ProcessStep }
  | { type: 'interaction'; key: string; step: ProcessStep };

export type ProcessTimelineSection =
  | { type: 'narrative'; key: string; itemId: string; content: string }
  | { type: 'execution'; key: string; sections: ProcessExecutionSection[]; steps: ProcessStep[] };

export function isSubtaskProcessStep(step: ProcessStep): boolean {
  if (step.type === 'subAgentActivity') return true;
  return step.type === 'collabAgentToolCall'
    && isCollabAgentSubtask(step.details as Record<string, unknown>);
}

export function buildProcessTimelineSections(
  timeline: ProcessTimelineEntry[],
  steps: ProcessStep[],
): ProcessTimelineSection[] {
  const stepById = new Map(steps.map((step) => [step.id, step]));
  const sections: ProcessTimelineSection[] = [];
  let pendingExecutionSections: ProcessExecutionSection[] = [];
  let pendingExecutionSteps: ProcessStep[] = [];
  let pendingOperations: ProcessStep[] = [];

  const flushOperations = () => {
    if (pendingOperations.length === 0) return;
    pendingExecutionSections.push({
      type: 'operations',
      key: `operations:${pendingOperations[0].id}`,
      steps: pendingOperations,
    });
    pendingOperations = [];
  };

  const flushExecution = () => {
    flushOperations();
    if (pendingExecutionSections.length === 0) return;
    sections.push({
      type: 'execution',
      key: `execution:${pendingExecutionSteps[0]?.id || 'empty'}`,
      sections: pendingExecutionSections,
      steps: pendingExecutionSteps,
    });
    pendingExecutionSections = [];
    pendingExecutionSteps = [];
  };

  for (const entry of timeline) {
    if (entry.type === 'narrative') {
      if (!entry.content || !entry.content.trim()) continue;
      flushExecution();
      sections.push({
        type: 'narrative',
        key: `narrative:${entry.itemId}`,
        itemId: entry.itemId,
        content: entry.content,
      });
      continue;
    }

    const step = stepById.get(entry.itemId);
    if (!step) continue;
    pendingExecutionSteps.push(step);
    if (step.type === 'interaction') {
      flushOperations();
      pendingExecutionSections.push({ type: 'interaction', key: `interaction:${step.id}`, step });
      continue;
    }
    if (isSubtaskProcessStep(step)) {
      flushOperations();
      pendingExecutionSections.push({ type: 'subtask', key: `subtask:${step.id}`, step });
      continue;
    }
    pendingOperations.push(step);
  }

  flushExecution();
  return sections;
}

export function getDefaultExpandedNarrativeItemId(
  timeline: ProcessTimelineEntry[],
  settled: boolean,
): string | null {
  if (settled) return null;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const entry = timeline[index];
    if (entry.type === 'narrative') return entry.itemId;
  }
  return null;
}
