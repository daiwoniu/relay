import type { ProcessStep, StreamingBlock } from './chat';

function mergeStep(previous: ProcessStep, incoming: ProcessStep): ProcessStep {
  const keepTerminalStatus = previous.status !== 'in_progress' && incoming.status === 'in_progress';
  return {
    ...previous,
    ...incoming,
    status: keepTerminalStatus ? previous.status : incoming.status,
    details: { ...previous.details, ...incoming.details },
  };
}

export function upsertProcessStep(
  processSteps: ProcessStep[],
  blocks: StreamingBlock[],
  incoming: ProcessStep,
): { processSteps: ProcessStep[]; blocks: StreamingBlock[] } {
  const firstStepIndex = processSteps.findIndex((step) => step.id === incoming.id);
  if (firstStepIndex < 0) {
    return {
      processSteps: [...processSteps, incoming],
      blocks: [...blocks, { type: 'step', step: incoming }],
    };
  }

  const merged = mergeStep(processSteps[firstStepIndex], incoming);
  const nextSteps = processSteps.filter((step) => step.id !== incoming.id);
  nextSteps.splice(firstStepIndex, 0, merged);

  let replacedBlock = false;
  const nextBlocks = blocks.flatMap((block) => {
    if (block.type !== 'step' || block.step?.id !== incoming.id) return [block];
    if (replacedBlock) return [];
    replacedBlock = true;
    return [{ ...block, step: merged }];
  });
  if (!replacedBlock) nextBlocks.push({ type: 'step', step: merged });

  return { processSteps: nextSteps, blocks: nextBlocks };
}
