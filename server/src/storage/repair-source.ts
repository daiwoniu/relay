import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseRolloutRepairTurns, buildRepairedTerminalSnapshot } from '../services/terminal-message-repair.js';
import { compactMessageItemsJsonForStorage } from '../messages/storage.js';
import { serializeTerminalMessageMetadata } from '../message-metadata.js';
import { canonicalJson } from './command-boundary.js';
import type { RepairCandidate, RepairEntry, JsonObject } from './contracts.js';
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
function inside(root: string, target: string) { const relative=path.relative(root,target); return !relative.startsWith('..') && !path.isAbsolute(relative); }
/** Read-only worker job. No storage connection, provider RPC or application bootstrap imports. */
export async function loadRepairSources(rootPath: string, candidates: readonly RepairCandidate[]): Promise<RepairEntry[]> {
  const root=await fs.realpath(rootPath), wanted=new Set(candidates.filter((c) => uuid.test(c.threadId)).map((c) => c.threadId));
  const found=new Map<string,string>(), duplicates=new Set<string>(); let visited=0; const deadline=Date.now()+25_000;
  async function scan(directory: string, depth: number): Promise<void> {
    if (depth>5) return;
    if (Date.now()>deadline) throw new Error('SOURCE_BUDGET');
    for await (const entry of await fs.opendir(directory)) {
      if (++visited>50_000 || Date.now()>deadline) throw new Error('SOURCE_BUDGET');
      if (entry.isSymbolicLink()) continue;
      const target=path.join(directory,entry.name);
      if (entry.isDirectory()) { const real=await fs.realpath(target); if (inside(root,real)) await scan(real,depth+1); }
      else if (entry.isFile()) {
        const match=/-([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\.jsonl$/i.exec(entry.name);
        if (!match || !wanted.has(match[1])) continue;
        if (found.has(match[1])) duplicates.add(match[1]); else found.set(match[1],target);
      }
    }
  }
  if (!wanted.size) return []; await scan(root,0);
  const result: RepairEntry[]=[]; let retained=2;
  for (const threadId of wanted) {
    if (duplicates.has(threadId)) continue;
    const filename=found.get(threadId); if (!filename) continue;
    try {
      const real=await fs.realpath(filename), before=await fs.lstat(filename);
      if (!inside(root,real) || before.isSymbolicLink() || !before.isFile() || before.size>64*1024*1024) continue;
      const handle=await fs.open(real,'r'); let text: string;
      try { const opened=await handle.stat(); if (!opened.isFile() || opened.size>64*1024*1024 || opened.dev!==before.dev || opened.ino!==before.ino) continue;
        text=await handle.readFile('utf8'); const after=await handle.stat();
        if (after.size!==opened.size || after.mtimeMs!==opened.mtimeMs) continue;
      } finally { await handle.close(); }
      const group=candidates.filter((c) => c.threadId===threadId);
      const parsed=parseRolloutRepairTurns(text!.split(/\r?\n/),new Set(group.map((c) => c.turnId)));
      if (parsed.threadId!==threadId) continue;
      for (const candidate of group) {
        try {
          if (candidate.contentDigest===null || candidate.contentLength===null) continue;
          const snapshot=buildRepairedTerminalSnapshot({messageId:randomUUID(),turnId:candidate.turnId,items:parsed.items.get(candidate.turnId)??[],
            duration:parsed.durations.get(candidate.turnId),projectRoot:candidate.projectRoot});
          if (!snapshot.content.trim() || snapshot.content.length!==candidate.contentLength || createHash('sha256').update(snapshot.content).digest('hex')!==candidate.contentDigest) continue;
          const entry: RepairEntry={candidate,snapshot:{messageId:snapshot.messageId,content:snapshot.content,
            items:compactMessageItemsJsonForStorage(snapshot.items??null).value,durationMs:snapshot.duration??null,
            metadata:JSON.parse(serializeTerminalMessageMetadata('completed',snapshot.metadata??{})??'{}') as JsonObject}};
          const cost=Buffer.byteLength(canonicalJson(entry,6*1024*1024))+1; if(retained+cost>6*1024*1024) continue;
          retained+=cost; result.push(entry);
        } catch { /* Unverified or oversized turn remains a preview issue, never a partial repair. */ }
      }
    } catch { /* Only return independently verified turns. No filesystem paths or parser text in diagnostics. */ }
  }
  return result;
}
