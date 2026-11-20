import path from 'node:path';
import {readWorkspaceFile} from './workspace-files.js';
import type {WorkspaceRunProjection} from './run-projection.js';

/** Only JUnit's bounded terminal counters and allowlisted exception names leave the log. */
export function projectJUnitResult(log:string):WorkspaceRunProjection['testResult']{
  if(!/^JUnit version \d+(?:\.\d+)+\s*$/m.test(log))return null;
  const summaries=[...log.matchAll(/^(?:OK \((\d+) tests?\)|Tests run:\s*(\d+),\s*Failures:\s*(\d+))\s*$/gm)];
  // Multiple suites need their own aggregation evidence, not the last suite's total.
  if(summaries.length!==1)return null;
  const match=summaries[0],total=Number(match[1]??match[2]),failures=match[1]?0:Number(match[3]);
  if(!Number.isSafeInteger(total)||!Number.isSafeInteger(failures)||total>1_000_000||failures>total)return null;
  const errors=['NullPointerException','AssertionError','ClassNotFoundException','NoClassDefFoundError','IllegalStateException','ExceptionInInitializerError'];
  return {framework:'junit',total,failures,errorTypes:failures?errors.filter(name=>new RegExp(`\\b${name}\\b`).test(log)):[]};
}

export async function readRunTestResult(root:string,directory:string,files:string[]):Promise<WorkspaceRunProjection['testResult']>{
  if(!files.includes('run.log'))return null;
  try{return projectJUnitResult(await readWorkspaceFile(root,path.join(directory,'run.log'),64*1024));}
  catch{return null;}
}
