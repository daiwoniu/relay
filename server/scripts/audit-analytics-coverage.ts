import { mkdirSync,writeFileSync } from 'node:fs';
import { ANALYTICS_COVERAGE,ANALYTICS_EQUIVALENT_POINTS,ANALYTICS_OBSERVATION_LIMITS } from '../src/analytics/coverage.js';
const groups=ANALYTICS_COVERAGE.map(group=>({id:group.id,label:group.label,implemented:group.registrations.filter(entry=>entry.status==='implemented'),pending:group.registrations.filter(entry=>entry.status==='planned').map(entry=>entry.id),retired:group.registrations.filter(entry=>entry.status==='retired').map(entry=>entry.id)}));
mkdirSync(new URL('../../.relay-dev/',import.meta.url),{recursive:true});
writeFileSync(new URL('../../.relay-dev/analytics-coverage.json',import.meta.url),JSON.stringify({at:new Date().toISOString(),groups,equivalentPoints:ANALYTICS_EQUIVALENT_POINTS,limits:ANALYTICS_OBSERVATION_LIMITS},null,2));
for(const group of groups)process.stdout.write(`${group.id}: implemented=${group.implemented.length} pending=${group.pending.length} retired=${group.retired.length}\n`);
