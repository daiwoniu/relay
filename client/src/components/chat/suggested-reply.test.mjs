import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractSuggestedReply,
  selectSuggestedReplyCandidate,
} from './suggested-reply.ts';

test('提取最终回复末尾明确给出的单一建议短语', () => {
  assert.equal(extractSuggestedReply('请回复 `确认第三阶段`，我会继续。'), '确认第三阶段');
  assert.equal(extractSuggestedReply('如果要我实施，请回复“确认开始实施”。'), '确认开始实施');
  assert.equal(extractSuggestedReply('设计完成。回复「继续」后进入下一步。'), '继续');
  assert.equal(extractSuggestedReply('需要你授权，请回复"同意临时连接 VPN"。'), '同意临时连接 VPN');
  assert.equal(
    extractSuggestedReply('按仓库硬门禁，HEAD 变化后需要重新确认版本选择。祥哥回复“确认升 0.18.2 并推送”即可继续。'),
    '确认升 0.18.2 并推送',
  );
});

test('识别 Markdown 包装和独占引用行中的明确建议回复', () => {
  assert.equal(
    extractSuggestedReply('如果同意以上范围，请明确回复：**“确认授权代码修改”**。'),
    '确认授权代码修改',
  );
  assert.equal(
    extractSuggestedReply('如同意，请回复：**“确认授权阶段一代码修改”**。'),
    '确认授权阶段一代码修改',
  );
  assert.equal(
    extractSuggestedReply('当前最适合执行的是第 1 步。若确认，可以回复：\n\n> 确认提交阶段一代码，仅提交不推送'),
    '确认提交阶段一代码，仅提交不推送',
  );
  assert.equal(
    extractSuggestedReply('这属于新的文件修改范围，需要本轮明确授权。请回复：\n\n确认授权准备审核材料，仅生成文件不执行'),
    '确认授权准备审核材料，仅生成文件不执行',
  );
  assert.equal(
    extractSuggestedReply('请回复：\n\n> **“确认授权阶段一”**。'),
    '确认授权阶段一',
  );
  assert.equal(
    extractSuggestedReply('请明确回复：**确认修改司法拍卖正式项目代码**。'),
    '确认修改司法拍卖正式项目代码',
  );
  assert.equal(
    extractSuggestedReply('请明确回复类似：\n\n> 同意启动分号三表正式 execute。'),
    '同意启动分号三表正式 execute',
  );
});

test('识别回复同义提示和明确给出的状态原文', () => {
  assert.equal(extractSuggestedReply('恢复后告诉我“VPN好了”，我会从只读预检继续。'), 'VPN好了');
  assert.equal(extractSuggestedReply('执行完告诉我“好了”，我再帮你核验状态。'), '好了');
  assert.equal(extractSuggestedReply('配置完成后告诉我“已配置并重启”。'), '已配置并重启');
  assert.equal(extractSuggestedReply('填好后告诉我“继续发布”即可。'), '继续发布');
  assert.equal(extractSuggestedReply('然后回复我“别名测试成功”。'), '别名测试成功');
  assert.equal(extractSuggestedReply('你回复“打开看看”，我就读取并整理文档。'), '打开看看');
  assert.equal(extractSuggestedReply('回复“授权触发 2273 一次”，我就立即执行。'), '授权触发 2273 一次');
  assert.equal(extractSuggestedReply('请明确回复：**接受 HTTP 明文风险并继续**。'), '接受 HTTP 明文风险并继续');
  assert.equal(extractSuggestedReply('推荐回复：`升 0.18.2，ACTIVE 一起提交推送。`'), '升 0.18.2，ACTIVE 一起提交推送');
  assert.equal(extractSuggestedReply('你说一句“按这个方案完善规则”，我就直接修改并运行规则审计。'), '按这个方案完善规则');
  assert.equal(extractSuggestedReply('该步骤需要单独授权。你回复“授权”后我直接执行；仍然不提交、不推送、不部署。'), '授权');
  assert.equal(extractSuggestedReply('请明确回复“确认并授权实现”，我才会创建原型并运行本地验证。'), '确认并授权实现');
  assert.equal(extractSuggestedReply('请明确回复“确认分范围提交”；这只提交、不推送。'), '确认分范围提交');
  assert.equal(extractSuggestedReply('你回复“已更新”，后面的数据库回查和缓存验证我全部接手。'), '已更新');
  assert.equal(extractSuggestedReply('祥哥回复“确认登记”后，我按上述方案更新配置。'), '确认登记');
  assert.equal(extractSuggestedReply('我建议补进权威规则和测试；你回复“确认修改”，我就落盘。'), '确认修改');
  assert.equal(extractSuggestedReply('请遵守上述规则。请回复“确认修改”，我就落盘。'), '确认修改');
  assert.equal(extractSuggestedReply('本轮只完成设计核查。你明确回复“确认创建 Jenkins Skill”后，我再实施。'), '确认创建 Jenkins Skill');
  assert.equal(extractSuggestedReply('本次不提交、不推送。请回复“确认”后我实施。'), '确认');
});

test('为高置信封闭问句生成最短建议回复', () => {
  assert.equal(extractSuggestedReply('这一层级和入口设计是否符合你的预期？'), '符合');
  assert.equal(extractSuggestedReply('这一组展示信息和操作排序是否合适？'), '合适');
  assert.equal(extractSuggestedReply('下一批将替换聊天入口并运行完整回归。可以继续吗？'), '继续');
  assert.equal(extractSuggestedReply('是否同意把字段命名为 `reportedFileChanges`？'), '同意');
  assert.equal(extractSuggestedReply('是否允许我创建独立 worktree 并保持主工作区不动？'), '允许');
  assert.equal(extractSuggestedReply('是否授权按以上范围联网下载依赖？仍保持不提交、不推送、不部署。'), '授权');
  assert.equal(extractSuggestedReply('请确认一下：Web 就按现有弹窗调整，对吗？'), '确认');
  assert.equal(extractSuggestedReply('是否按方案 1 继续完成详细设计？'), '1');
  assert.equal(extractSuggestedReply('如果这部分也确认，我就把完整设计写入计划文档。'), '确认');
  assert.equal(extractSuggestedReply('这个组件和状态架构是否确认？确认后我会整理测试标准。'), '确认');
  assert.equal(extractSuggestedReply('设计已经完整，是否现在建立隔离 worktree 并开始编码？'), '同意');
  assert.equal(
    extractSuggestedReply('是否确认我新建独立 worktree：\n\n- 路径：`.worktrees/example`\n- 分支：`feature/example`\n\n并保持主工作区不动？'),
    '确认',
  );
  assert.equal(extractSuggestedReply('请确认：先同步并合并现有功能分支，然后开始下一项功能？'), '确认');
  assert.equal(
    extractSuggestedReply('是否允许我将功能分支变基到最新 `main`？推荐变基。\n\n`npm run restart`：合并后需要。'),
    '允许',
  );
});

test('只识别正文尾部且拒绝过长、多行和危险内容', () => {
  assert.equal(extractSuggestedReply(`请回复“确认旧内容”。${'说明'.repeat(700)}`), null);
  assert.equal(extractSuggestedReply(`请回复“确认${'很'.repeat(120)}长”。`), null);
  assert.equal(extractSuggestedReply('请回复“确认第一阶段\n确认第二阶段”。'), null);
  assert.equal(extractSuggestedReply('请回复“确认 https://example.com”。'), null);
  assert.equal(extractSuggestedReply('请回复“确认 C:\\temp\\file.txt”。'), null);
  assert.equal(extractSuggestedReply('请回复“确认 /etc/hosts”。'), null);
  assert.equal(extractSuggestedReply('请回复“确认; Remove-Item x”。'), null);
  assert.equal(extractSuggestedReply('请回复“1. 确认执行”。'), null);
  assert.equal(extractSuggestedReply('请回复“1、确认执行”。'), null);
  assert.equal(extractSuggestedReply('请回复“1)2 确认执行”。'), null);
  assert.equal(extractSuggestedReply('请回复“1、2 确认执行”。'), null);
});

test('明确状态原文可提取，但不自行生成完成声明', () => {
  assert.equal(extractSuggestedReply('执行后回复“已启动”。'), '已启动');
  assert.equal(extractSuggestedReply('执行后回复“确认已启动”。'), '确认已启动');
  assert.equal(extractSuggestedReply('停止完成后回复“已停止”。'), '已停止');
  assert.equal(extractSuggestedReply('操作完成后告诉我。'), null);
  assert.equal(extractSuggestedReply('发布完成后告诉我，我会继续验收。'), null);
});

test('拒绝多选和开放问题', () => {
  assert.equal(extractSuggestedReply('请选择：\n1. 方案一\n2. 方案二'), null);
  assert.equal(extractSuggestedReply('是否确认采用方案一？'), null);
  assert.equal(extractSuggestedReply('请告诉我你的服务器地址。'), null);
  assert.equal(extractSuggestedReply('回复“提交”或“提交推送”，我完成 Git 收尾。'), null);
  assert.equal(
    extractSuggestedReply('请在管理员菜单完成页面验收。确认页面符合后，我会清理 worktree。'),
    null,
  );
  assert.equal(
    extractSuggestedReply('请选择：\nA. 直接执行（推荐）\nB. 继续检查'),
    null,
  );
  assert.equal(extractSuggestedReply('是否按方案 1 继续，还是改用方案 2？'), null);
  assert.equal(extractSuggestedReply('是否按方案 1 或方案 2 继续？'), null);
  assert.equal(
    extractSuggestedReply('是否允许我删除旧分支？不过先不要操作。你更倾向哪个方案？'),
    null,
  );
  assert.equal(
    extractSuggestedReply('请确认：是否执行部署？先不要执行。还有哪些风险需要检查？'),
    null,
  );
});

test('拒绝代码、示例和叙述语境中的伪回复提示', () => {
  assert.equal(
    extractSuggestedReply([
      '从回复末尾识别明确话术，例如：',
      '- `请回复“确认开始实施”` → `确认开始实施`',
      '- `可以继续吗？` → `继续`',
      '',
      '以上只是规则说明，不需要用户确认。',
    ].join('\n')),
    null,
  );
  assert.equal(
    extractSuggestedReply('老师告诉我：“真正的勇敢，是害怕时仍愿意做正确的事情。”\n\n我会记住这句话。'),
    null,
  );
  assert.equal(
    extractSuggestedReply('接口会在异常回复中返回 `messageId`，用于定位同一轮消息。'),
    null,
  );
  assert.equal(
    extractSuggestedReply('```text\n请回复“确认执行”\n```\n\n这是文档中的命令示例。'),
    null,
  );
  assert.equal(extractSuggestedReply('同事告诉我“网络已恢复”。'), null);
  assert.equal(extractSuggestedReply('他告诉我“已配置”。'), null);
  assert.equal(extractSuggestedReply('异常回复“确认执行”用于测试。'), null);
  assert.equal(extractSuggestedReply('下面是反例：请回复“确认执行”。'), null);
  assert.equal(extractSuggestedReply('文档写着：请回复“确认执行”。'), null);
  assert.equal(extractSuggestedReply('下面是示例：推荐回复：“确认执行”。'), null);
  assert.equal(extractSuggestedReply('文档写着：你说一句“确认执行”。'), null);
  assert.equal(extractSuggestedReply('文档：请回复“确认执行”。'), null);
  assert.equal(extractSuggestedReply('规则：你说一句“确认执行”。'), null);
  assert.equal(extractSuggestedReply('系统提示：推荐回复：“确认执行”。'), null);
  assert.equal(extractSuggestedReply('请回复“确认执行”；这只是示例。'), null);
  assert.equal(extractSuggestedReply('请回复“确认执行”；仅作为示例。'), null);
  assert.equal(extractSuggestedReply('请回复“确认执行”，我会解释为什么这只是示例。'), null);
  assert.equal(extractSuggestedReply('请回复“确认执行”，我再举例说明。'), null);
  assert.equal(
    extractSuggestedReply('规则说明如下：请回复“确认执行”。接下来还有简短解释。'),
    null,
  );
  assert.equal(extractSuggestedReply('请回复“确认执行”。我这里只是在举例。'), null);
});

test('拒绝带 Markdown 包装、连接词或候选内部表达的多选回复', () => {
  assert.equal(extractSuggestedReply('请回复：**“确认”** 或 **“同意”**。'), null);
  assert.equal(extractSuggestedReply('请回复：__“确认”__ 或 __“同意”__。'), null);
  assert.equal(extractSuggestedReply('请回复“确认”和“同意”任选其一。'), null);
  assert.equal(extractSuggestedReply('请回复“确认”以及“同意”中的一个。'), null);
  assert.equal(extractSuggestedReply('请回复“确认/同意”。'), null);
  assert.equal(extractSuggestedReply('请回复“确认或同意”。'), null);
  assert.equal(extractSuggestedReply('推荐回复：“确认”或“同意”。'), null);
  assert.equal(extractSuggestedReply('请回复“选1”或“选2”。'), null);
});

test('按行动后缀判断末尾指令，不使用固定字符数截断', () => {
  assert.equal(
    extractSuggestedReply(`请回复“确认执行”。收到后我会：\n\n${'- 核对执行范围和安全边界。\n'.repeat(30)}`),
    '确认执行',
  );
  assert.equal(
    extractSuggestedReply('请回复“确认执行”。接下来解释这一句为什么只是测试样例。'),
    null,
  );
});

test('拒绝否定语境中的回复短语', () => {
  assert.equal(extractSuggestedReply('无需回复“确认”。'), null);
  assert.equal(extractSuggestedReply('无需再回复“确认开始实施”。'), null);
  assert.equal(extractSuggestedReply('不要回复“确认开始实施”。'), null);
  assert.equal(extractSuggestedReply('不用回复“继续”。'), null);
  assert.equal(extractSuggestedReply('不必回复“同意执行”。'), null);
  assert.equal(extractSuggestedReply('请勿回复“确认”。'), null);
  assert.equal(extractSuggestedReply('不需要你回复“确认”。'), null);
  assert.equal(extractSuggestedReply('别回复“确认”。'), null);
  assert.equal(extractSuggestedReply('不建议你回复“确认”。'), null);
  assert.equal(extractSuggestedReply('不推荐回复“确认”。'), null);
  assert.equal(extractSuggestedReply('不推荐你回复“确认”。'), null);
  assert.equal(extractSuggestedReply('这并非推荐回复“确认”。'), null);
  assert.equal(extractSuggestedReply('不再需要你回复“确认”。'), null);
  assert.equal(extractSuggestedReply('禁止回复“确认”。'), null);
  assert.equal(extractSuggestedReply('这个方案是否不符合你的预期？'), null);
  assert.equal(extractSuggestedReply('这一组操作是否不合适？'), null);
  assert.equal(extractSuggestedReply('现在是否不允许继续？'), null);
  assert.equal(extractSuggestedReply('是否无需继续？'), null);
});

const assistantMessage = {
  id: 'assistant-1',
  role: 'assistant',
  content: '请回复“确认开始实施”。',
  outcome: 'completed',
  stopped: false,
};

test('只为当前会话最后一条成功助手消息返回候选', () => {
  assert.deepEqual(selectSuggestedReplyCandidate([assistantMessage], false), {
    sourceMessageId: 'assistant-1',
    text: '确认开始实施',
  });
  assert.equal(selectSuggestedReplyCandidate([
    assistantMessage,
    { id: 'user-2', role: 'user', content: '确认开始实施', stopped: false },
  ], false), null);
  assert.equal(selectSuggestedReplyCandidate([{ ...assistantMessage, isError: true }], false), null);
  assert.equal(selectSuggestedReplyCandidate([{ ...assistantMessage, outcome: 'failed' }], false), null);
  assert.equal(selectSuggestedReplyCandidate([{ ...assistantMessage, stopped: true }], false), null);
  assert.equal(selectSuggestedReplyCandidate([assistantMessage], true), null);
  assert.equal(selectSuggestedReplyCandidate([{ ...assistantMessage, content: '已经完成。' }], false), null);
});
