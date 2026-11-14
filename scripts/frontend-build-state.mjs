import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFrontendBuildStatus } from './lib/frontend-build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
console.log(JSON.stringify(getFrontendBuildStatus(root), null, 2));
