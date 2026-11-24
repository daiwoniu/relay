import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { CollectionError, withEdge } from './edge.mjs';
import { collectKuaishou, collectWechat, collectXiaohongshu } from './sources.mjs';

const help = `公开内容关键词采集（Node.js 24，Windows Edge 用于小红书和快手）

  node collect.mjs --keyword "AI Agent"
  node collect.mjs --keyword "具身智能" --source wechat --pages 2 --output results.json

  --source all|xiaohongshu|kuaishou|wechat   默认 all
  --scrolls N     小红书向下滚动次数，默认 8，0 仅取首批
  --pages N       公众号搜索最多读取页数，默认 2，按网页提供的下一页链接继续
  --profile PATH  已登录的专用 Edge 配置，默认 %LOCALAPPDATA%\\Relay-Search-Edge-Test
  --edge PATH     Edge 可执行文件路径
  --output PATH   写入一个新建 UTF-8 JSON 文件，省略时输出到终端
  --help          显示用法

小红书从网页卡片提取。快手读取网页产生的首批 JSON。
公众号提取搜狗搜索结果的标题、公众号、时间、摘要和链接。
JSON 按来源报告状态。任一来源失败或部分完成时，退出码为 2。
`;

const sources = ['xiaohongshu', 'kuaishou', 'wechat'];

function integer(value, option, minimum) {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${option} 应为大于等于 ${minimum} 的整数。`);
  }
  return number;
}

function argumentsFrom(argv) {
  const { values } = parseArgs({ args: argv, options: {
    keyword: { type: 'string' }, source: { type: 'string', default: 'all' },
    pages: { type: 'string', default: '2' }, scrolls: { type: 'string', default: '8' },
    profile: { type: 'string' }, edge: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) return values;
  const keyword = values.keyword?.trim();
  if (!keyword) throw new Error('请通过 --keyword 提供关键词。');
  const selected = values.source === 'all' ? sources : [values.source];
  if (selected.some((source) => !sources.includes(source))) throw new Error('--source 应为 all、xiaohongshu、kuaishou 或 wechat。');
  const defaultProfile = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Relay-Search-Edge-Test') : null;
  const defaultEdge = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  return { keyword, selected, pages: integer(values.pages, '--pages', 1), scrolls: integer(values.scrolls, '--scrolls', 0),
    profile: values.profile ? resolve(values.profile) : defaultProfile, edgePath: values.edge ?? defaultEdge, output: values.output };
}

function failed(source, error) {
  if (error instanceof CollectionError) return { source, status: error.status, message: error.message, items: [] };
  const cause = error?.cause?.code;
  const reason = typeof cause === 'string' && /^[A-Z\d_]+$/.test(cause) ? `（${cause}）` : '';
  return { source, status: 'error', message: `采集请求失败${reason}。`, items: [] };
}

async function runSource(source, collect) {
  try {
    const result = await collect();
    return { source, status: result.incomplete ? 'partial' : 'ok', ...result };
  } catch (error) {
    return failed(source, error);
  }
}

async function collect(options) {
  const browserSources = options.selected.filter((source) => source !== 'wechat');
  const browserJobs = async () => {
    if (!browserSources.length) return [];
    try {
      if (!options.profile) throw new CollectionError('profile_missing', '请通过 --profile 提供已登录的专用 Edge 配置。');
      return await withEdge(options, async (browser) => {
        const output = [];
        for (const source of browserSources) {
          output.push(await runSource(source, () => browser.withTab((tab) => source === 'xiaohongshu'
            ? collectXiaohongshu(tab, options.keyword, options.scrolls)
            : collectKuaishou(tab, options.keyword))));
        }
        return output;
      });
    } catch (error) {
      return browserSources.map((source) => failed(source, error));
    }
  };
  const operations = [browserJobs()];
  if (options.selected.includes('wechat')) operations.push(runSource('wechat', () => collectWechat(options.keyword, options.pages)));
  return (await Promise.all(operations)).flat();
}

try {
  const options = argumentsFrom(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(help);
  } else {
    const results = await collect(options);
    const output = JSON.stringify({ keyword: options.keyword, collectedAt: new Date().toISOString(), results }, null, 2) + '\n';
    if (options.output) await writeFile(options.output, output, { encoding: 'utf8', flag: 'wx' });
    else process.stdout.write(output);
    if (results.some(({ status }) => status !== 'ok')) process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error.code === 'EEXIST' ? '输出文件已存在，请选择一个新文件名。' : error.message}\n`);
  process.exitCode = 1;
}
