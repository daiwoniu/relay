interface ProcessStepDisclosureInput {
  title: string;
  fullTitle?: string;
  command?: string;
  metadata?: string[];
  output?: string;
}

export function getProcessStepDisclosureState(info: ProcessStepDisclosureInput) {
  const fullTitle = info.fullTitle || info.title;
  const hasSupplementalDetails = Boolean(
    info.command
      || info.output
      || (info.metadata && info.metadata.length > 0),
  );

  return {
    canExpand: Boolean(fullTitle || hasSupplementalDetails),
    fullTitle,
    hasSupplementalDetails,
  };
}
