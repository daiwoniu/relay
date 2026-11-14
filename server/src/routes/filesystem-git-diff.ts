import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 512 * 1024;

async function git(cwd: string, args: string[], allowDiffExit = false): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, '--literal-pathspecs', ...args], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: MAX_DIFF_BYTES,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch (error) {
    if (allowDiffExit && (error as { code?: number }).code === 1) {
      return (error as { stdout?: string }).stdout ?? '';
    }
    throw error;
  }
}

export interface FileGitDiffResult {
  changed: boolean;
  diff: string;
}

/** Compare the current file with HEAD, including staged, unstaged and untracked content. */
export async function readFileGitDiff(realPath: string): Promise<FileGitDiffResult> {
  const cwd = path.dirname(realPath);
  let root: string;
  try {
    root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return { changed: false, diff: '' };
  }
  const relative = path.relative(root, realPath).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return { changed: false, diff: '' };

  let diff: string;
  try {
    diff = await git(root, ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', 'HEAD', '--', relative]);
  } catch (error) {
    // An unborn repository has no HEAD; every present file is new relative to it.
    try {
      await git(root, ['rev-parse', '--verify', 'HEAD']);
    } catch {
      const indexed = await git(root, ['ls-files', '-z', '--', relative]);
      const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', relative]);
      if (!indexed && !untracked) return { changed: false, diff: '' };
      const initialDiff = await git(root, ['-c', 'core.quotePath=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', '/dev/null', realPath], true);
      return { changed: initialDiff.length > 0, diff: initialDiff };
    }
    throw error;
  }
  if (diff) return { changed: true, diff };
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', relative]);
  if (!untracked) return { changed: false, diff: '' };
  diff = await git(root, ['-c', 'core.quotePath=false', 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', '/dev/null', realPath], true);
  return { changed: diff.length > 0, diff };
}
