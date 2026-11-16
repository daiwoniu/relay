import fs from 'node:fs';
import { registerHooks } from 'node:module';
import ts from 'typescript';

export async function loadTsxForTest(url, stubs = new Map()) {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        const candidate = new URL(specifier, context.parentURL);
        for (const extension of ['.ts', '.tsx']) {
          const target = new URL(candidate.href + extension);
          if (fs.existsSync(target)) return { url: target.href, shortCircuit: true };
        }
      }
      return nextResolve(specifier, context);
    },
    load(moduleUrl, context, nextLoad) {
      if (stubs.has(moduleUrl)) return { format: 'module', source: stubs.get(moduleUrl), shortCircuit: true };
      if (moduleUrl.endsWith('.tsx')) return {
        format: 'module', shortCircuit: true,
        source: ts.transpileModule(fs.readFileSync(new URL(moduleUrl), 'utf8'), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText,
      };
      return nextLoad(moduleUrl, context);
    },
  });
  try { return await import(url); }
  finally { hooks.deregister(); }
}
