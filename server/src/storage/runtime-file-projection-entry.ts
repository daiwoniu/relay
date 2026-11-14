import { parentPort, workerData } from 'node:worker_threads';
import { collectChangedFiles, hasIncompleteChangedFilesReport } from '../messages/changed-files.js';
const { items, projectRoot } = workerData;
parentPort!.postMessage({ changedFiles: collectChangedFiles(items, projectRoot),
  changedFilesIncomplete: hasIncompleteChangedFilesReport(items, projectRoot) });
