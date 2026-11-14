import fs from 'node:fs';
import { loadAndVerifySession } from './lib/auth-session.mjs';
import { loadAcceptanceConfig } from './lib/config.mjs';
import { runDpapi } from './lib/dpapi.mjs';
import { SESSION_PATH } from './lib/paths.mjs';
import { runReadOnlyAcceptance } from './lib/read-only-scenarios.mjs';
import { captureDocumentationScreenshots } from './lib/documentation-screenshots.mjs';
import { formatCommandHelp, hasHelpArgument, printHelp } from '../lib/help.mjs';

if (process.argv.length === 3 && hasHelpArgument(process.argv.slice(2))) {
  printHelp(formatCommandHelp('screenshots:readme'));
} else if (process.argv.length !== 2) {
  console.error('用法：npm run screenshots:readme（仅截取固定文档场景，不接受引擎或任意URL参数）');
  process.exitCode = 1;
} else {
  try {
    const config = loadAcceptanceConfig();
    const session = await loadAndVerifySession({ config,
      readSession: async () => fs.readFileSync(SESSION_PATH, 'utf8').trim(),
      unprotect: (value) => runDpapi('unprotect', value),
    });
    console.log('文档截图场景：首页、移动首页、工具集；示例数据展示助手三视图、多引擎维护、Markdown/Git/HTML预览。不发送真实消息或修改业务数据。');
    const report = await runReadOnlyAcceptance({ config, cookieValue: session.cookieValue,
      runAdditionalScenarios: ({ page, runtime }) => captureDocumentationScreenshots({ page, runtime, config }),
    });
    console.log(`截图结论：${report.status}\n运行目录：.relay-dev/acceptance/${report.runId}`);
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : '文档截图失败');
    process.exitCode = 1;
  }
}
