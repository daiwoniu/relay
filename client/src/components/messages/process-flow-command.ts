/** Identify the invocation, never arbitrary arguments or an inline program's contents. */
export function describeCommandInvocation(command: string): { label?: string; script?: string; operation?: string; inline?: string; module?: string; check?: boolean } {
  if (/^\s*\$(?:[A-Za-z_]\w*:)?[A-Za-z_]\w*\s*(?:\+?=)/.test(command)) return { label: '变量赋值', inline: 'PowerShell' };
  const tokens: string[] = [];
  let end = 0;
  for (const match of command.slice(0, 4096).matchAll(/"([^"]*)"|'([^']*)'|([^\s|;&]+)/g)) {
    // Only inspect the first shell statement; quoted separators stay inside a token.
    if (tokens.length && /[|;&\r\n]/.test(command.slice(end, match.index))) break;
    tokens.push(match[1] ?? match[2] ?? match[3]);
    end = match.index! + match[0].length;
  }
  const name = (value = '') => value.replace(/\\/g, '/').split('/').pop() || '';
  const safe = (value = '') => /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value) ? value : undefined;
  const script = (value = '') => value.length <= 512 && !/[\r\n$`]/.test(value) && /\.(?:[cm]?js|tsx?|py|ps1|sh)$/i.test(value);
  const operation = (start: number) => {
    for (let index = start; index < tokens.length; index++) {
      const token = tokens[index];
      if (/^(?:--json|--quiet|--verbose|--dry-run|--read-only)$/.test(token)) continue;
      if (/^--(?:profile|config|project|server|target|host|port|user|database|db|env)(?:=|$)/.test(token)) { if (!token.includes('=')) index++; continue; }
      return token.length <= 64 && /^(?:list|show|get|read|write|query|search|fetch|inspect|validate|check|run|execute|plan|apply|status|create|update|delete|download|upload|tail|describe|catalog|connect|test|build|select|logs?|cancel|stop|start|restart)(?:[_-][a-z0-9]+)*$/i.test(token) ? token : undefined;
    }
  };
  while (/^(?:rtk|npx)(?:\.exe|\.cmd)?$/i.test(name(tokens[0])) && tokens.length > 1) {
    const wrapper = name(tokens.shift()).replace(/\.(?:exe|cmd)$/i, '').toLowerCase();
    if (wrapper === 'rtk' && /^(?:err|test)$/i.test(tokens[0])) tokens.shift();
    if (wrapper === 'npx') while (/^(?:--no-install|--yes|-y|--offline)$/.test(tokens[0] || '')) tokens.shift();
    if (tokens[0]?.startsWith('-')) return { label: wrapper };
  }
  if (script(tokens[0])) return { label: '脚本文件', script: tokens[0], operation: operation(1) };
  const program = safe(name(tokens[0]));
  if (!program) return {};
  const base = program.replace(/\.(?:exe|cmd)$/i, '').toLowerCase();
  if (base === 'npm' || base === 'pnpm' || base === 'yarn' || base === 'git') {
    let index = 1;
    while (tokens[index]?.startsWith('-')) {
      if (/^(?:--prefix|--workspace|-w|-C|--cwd|--dir|--git-dir|--work-tree|-c)$/.test(tokens[index])) index += 2;
      else if (/^(?:--silent|--quiet|--no-pager|--no-install|--offline|-s)$/.test(tokens[index]) || /^--(?:prefix|workspace|cwd|dir|git-dir|work-tree)=/.test(tokens[index])) index++;
      else break;
    }
    const action = safe(tokens[index]);
    const task = /^(?:run|exec)$/i.test(action || '') ? safe(tokens[index + 1]) : undefined;
    return { label: [program, action, task].filter(Boolean).join(' ') };
  }
  const runtime = /^(?:node|tsx|python|python3(?:\.\d+)?|powershell|pwsh|bash|sh)$/.test(base);
  if (!runtime) return { label: program };
  let check = false;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (base === 'node' && /^(?:-c|--check)$/.test(token)) { check = true; continue; }
    const shell = /^(?:powershell|pwsh)$/.test(base);
    const inlineOption = shell ? /^(?:-c|-command|-commandwithargs|-encodedcommand)$/i
      : base.startsWith('python') ? /^-c/
        : /^(?:bash|sh)$/.test(base) ? /^-[a-z]*c[a-z]*$/
          : /^(?:(?:-e|--eval|-p|--print)(?:=|$)|-[ep].+)/;
    if (inlineOption.test(token) || token === '-') return { label: program, inline: shell ? 'PowerShell' : /^python/.test(base) ? 'Python' : /^(?:bash|sh)$/.test(base) ? 'Shell' : 'Node.js' };
    if (/^python/.test(base) && token === '-m') {
      const module = tokens[index + 1];
      return { label: `${program} -m`, ...(/^[A-Za-z_][\w.]{0,79}$/.test(module || '') ? { module } : {}) };
    }
    if (/^(?:--import|--require|-r|--loader|--experimental-loader|--test-name-pattern|--test-reporter|--conditions|-executionpolicy)$/i.test(token) || /^python/.test(base) && /^(?:-W|-X)$/.test(token)) { index++; continue; }
    if (/^(?:--version|-v|--help|-h)$/i.test(token)) return { label: program };
    if (token.startsWith('-')) continue;
    return { label: program, ...(script(token) ? { script: token, operation: operation(index + 1), ...(check ? { check: true } : {}) } : {}) };
  }
  return { label: program };
}

/** Inspect actual read statements, skipping quoted program text and other shell statements. */
export function describeReadCommands(command: string): string[] {
  const reads: string[] = [];
  let start = 0;
  const add = (part: string) => {
    const value = part.trim().replace(/^rtk\s+err\s+/i, '');
    if (/^(?:Get-Content\b|gc\s|cat\s|type\s|rtk\s+read\s)/i.test(value)) reads.push(value);
  };
  for (const match of command.slice(0, 16000).matchAll(/"(?:\\.|`.|[^"\\`])*"|'(?:''|[^'])*'|[;|\r\n]|&&/g)) {
    if (/^[;|\r\n]|^&&$/.test(match[0])) { add(command.slice(start, match.index)); start = match.index! + match[0].length; }
  }
  add(command.slice(start, 16000));
  return reads;
}

/** Extract display metadata from common read/search commands; never execute shell text. */
export function describeCommandTarget(command: string): { query?: string; paths: string[] } {
  const read = /^(?:get-content|gc|cat|type|rtk\s+read)(?:\s|$)/i.test(command.trim());
  const tokens: string[] = [];
  const pattern = read ? /@\((?:\s*(?:"[^"]*"|'[^']*')\s*,?)*\)|"([^"]*)"|'([^']*)'|([^\s,]+)|,/g : /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  for (const match of command.matchAll(pattern)) {
    if (match[3] === '|' || match[3] === ';') break;
    if (match[0] !== ',') tokens.push(match[1] ?? match[2] ?? match[3] ?? match[0]);
  }
  const values = (token: string) => token.startsWith('@(') ? [...token.matchAll(/"([^"]*)"|'([^']*)'/g)].map(match => match[1] ?? match[2]) : [token];
  const option = (...names: string[]) => { const at = tokens.findIndex(token => names.includes(token.toLowerCase())); return at >= 0 ? tokens[at + 1] : undefined; };
  const script = tokens.findIndex(token => /(?:^|[\\/])search\.mjs$/i.test(token));
  if (script >= 0) return { query: tokens.slice(script + 2).join(' '), paths: [] };
  if (/select-string/i.test(tokens[0] || '')) return { query: option('-pattern'), paths: [option('-literalpath', '-path')].filter((value): value is string => Boolean(value)) };
  const paths: string[] = [];
  const explicitPatterns: string[] = [];
  const positional: string[] = [];
  for (let index = tokens[0] === 'rtk' ? 2 : 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (['-path', '-literalpath'].includes(token.toLowerCase())) { if (tokens[index + 1]) paths.push(...values(tokens[++index])); continue; }
    if (['-e', '--regexp'].includes(token)) { if (tokens[index + 1]) explicitPatterns.push(tokens[++index]); continue; }
    if (read && ['-encoding', '-totalcount', '-tail', '-head', '-first', '-skip', '-filter', '-include', '-exclude', '-erroraction', '-ea', '-readcount', '-delimiter', '-stream'].includes(token.toLowerCase()) || /^(?:-g|--glob|--iglob|-t|--type|--type-not|-A|-B|-C|--context|--max-count|--max-depth|-m|--ignore-file)$/.test(token)) { index++; continue; }
    if (token === '--') { positional.push(...tokens.slice(index + 1)); break; }
    if (!token.startsWith('-')) positional.push(...(read ? values(token) : [token]));
  }
  if (read) return { paths: [...paths, ...positional] };
  if (tokens.includes('--files')) return { paths: [...paths, ...positional] };
  return { query: explicitPatterns.join(' | ') || positional.shift(), paths: [...paths, ...positional] };
}

/** Describe requested line selection, not the amount actually returned by the file. */
export function describeReadRange(command: string): string | undefined {
  const stages: string[][] = [[]];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)) {
    if (match[3] === ';') return undefined;
    if (match[3] === '|') stages.push([]);
    else stages[stages.length - 1].push(match[1] ?? match[2] ?? match[3]);
  }
  const first = stages[0];
  if (!/^get-content$/i.test(first[0] || '')) return undefined;
  if (first.some(token => /^-raw$/i.test(token))) return '整段文本';
  if (first.some(token => /^-(?:readcount|delimiter|asbytestream)$/i.test(token))) return '按命令指定格式读取';
  const count = (tokens: string[], names: string[]) => {
    const at = tokens.findIndex(token => names.includes(token.toLowerCase()));
    const value = tokens[at + 1];
    return at >= 0 && /^\d{1,8}$/.test(value || '') ? Number(value) : undefined;
  };
  let tail = count(first, ['-tail']);
  let limit = count(first, ['-totalcount', '-head']);
  let skip = 0;
  for (const stage of stages.slice(1)) {
    if (!/^select-object$/i.test(stage[0] || '') || stage.some(token => /^-(?:skiplast|index|expandproperty|property)$/i.test(token))) return '部分内容（按命令筛选）';
    const nextTail = count(stage, ['-last']);
    const nextSkip = count(stage, ['-skip']) || 0;
    const nextLimit = count(stage, ['-first']);
    if (nextTail !== undefined && nextLimit !== undefined) return '部分内容（按命令筛选）';
    if (nextTail !== undefined) {
      if (skip || limit !== undefined || tail !== undefined) return `筛选末尾 ${nextTail} 行`;
      tail = nextTail;
    }
    skip += nextSkip;
    if (limit !== undefined) limit = Math.max(0, limit - nextSkip);
    if (nextLimit !== undefined) limit = Math.min(limit ?? nextLimit, nextLimit);
  }
  if (tail !== undefined) return `最后 ${tail} 行${skip ? `中跳过 ${skip} 行` : ''}${limit !== undefined ? `，读取 ${limit} 行` : ''}`;
  if (limit === 0) return '请求读取 0 行';
  if (skip && limit !== undefined) return `第 ${skip + 1}～${skip + limit} 行`;
  if (skip) return `跳过前 ${skip} 行`;
  return limit !== undefined ? `前 ${limit} 行` : undefined;
}
