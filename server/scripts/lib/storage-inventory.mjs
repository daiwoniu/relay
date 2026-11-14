import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const calls = new Set(['getDB', 'initDB', 'saveToFile', 'scheduleSaveToFile', 'flushPendingSave',
  'restoreFromBytes', 'raw', 'export', 'writeFileAtomically', 'persistDatabase', 'openDatabase']);

/** Candidate inventory only; contains symbols/locations, never SQL, arguments or source lines. */
export function inspectSource(filename, source) {
  const databaseModule = /(?:^|[\\/])db[\\/]/.test(filename);
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const bindings = new Set();
  const imports = [];
  const sites = [];
  for (const node of tree.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const specifier = node.moduleSpecifier.text;
    if (!/sql\.js|(?:^|\/)db\/|news\/storage\//.test(specifier) && !databaseModule) continue;
    imports.push(specifier);
    if (node.importClause?.isTypeOnly) continue;
    if (node.importClause?.name) bindings.add(node.importClause.name.text);
    const named = node.importClause?.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.add(named.name.text);
    if (named && ts.isNamedImports(named)) for (const item of named.elements) {
      if (!item.isTypeOnly) bindings.add(item.name.text);
    }
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression;
      const symbol = ts.isIdentifier(expression) ? expression.text
        : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
      const base = ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
        ? expression.expression.text : null;
      const databaseCall = ['get', 'all', 'run', 'exec', 'prepare'].includes(symbol)
        && (databaseModule || ['db', 'sqlDb', 'snapshotDb', 'instance', 'database'].includes(base));
      if (symbol && (databaseCall || calls.has(symbol) || bindings.has(symbol) || bindings.has(base))) {
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        sites.push({ line, symbol });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { imports, sites, envOverride: /\bRELAY_DB_PATH\b/.test(source) };
}

export function collectInventory(root) {
  const files = [];
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(name);
      else if (/\.(?:ts|mjs)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)
        && !name.includes('storage-probe') && !name.includes('storage-inventory')) files.push(name);
    }
  };
  for (const directory of ['server/src', 'server/scripts', 'scripts', 'ai/scripts']) walk(directory);
  // Explicitly known maintenance entry; never recursively scan the user's .relay-dev workspace.
  const maintenance = '.relay-dev/approval-terminal-fix/restore-and-restart.mjs';
  if (fs.existsSync(path.join(root, maintenance))) files.push(maintenance);
  const entries = [];
  for (const filename of files.sort()) {
    const analysis = inspectSource(filename, fs.readFileSync(path.join(root, filename), 'utf8'));
    if (!analysis.imports.length && !analysis.sites.length && !analysis.envOverride) continue;
    const news = filename.includes('/news/');
    const verification = /(?:verify-|probe-|acceptance\/)/.test(filename);
    const tooling = filename.startsWith('server/scripts/') || filename.startsWith('scripts/') || filename.startsWith('ai/') || filename.startsWith('.relay-dev/');
    entries.push({ file: filename, database: news ? 'news metadata/monthly' : 'main or explicit test override',
      execution: tooling ? 'standalone tool' : 'backend main thread (current)',
      batch: verification ? 'T1/T6d test tooling' : news ? 'T6d' : tooling ? 'T6b/T6c/T6d'
        : /engine-concurrency|engine\/concurrency|turn-admission/.test(filename) ? 'T4a/T4b'
        : /engine-turn-facts/.test(filename) ? 'T4c/T4d'
        : /engine\/|terminal|followup|host-context|ws\/frontend\.ts/.test(filename) ? 'T4c/T4d'
        : /auth|account|approval-trust|client-hub|admin-audit/.test(filename) ? 'T5a'
        : /trash|share|attachment/.test(filename) ? 'T5c'
        : /workspace|usage|attention|session-read|day-panel/.test(filename) ? 'T5d' : 'T5b/T6a',
      ...analysis });
  }
  return { version: 1, scope: ['server/src', 'server/scripts', 'scripts', 'ai/scripts', maintenance],
    limitations: ['Static candidate list; business transactions require T2 manual mapping.',
      'Does not infer dynamic/reflection calls or transitively prove every caller is migrated.',
      'Only the explicitly named local maintenance entry is inspected outside owned source roots.'], entries };
}
