import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_SESSION_TITLE_LENGTH,
  classifySessionTitleMessage,
  generateSessionTitle,
  isSubstantiveSessionTitleMessage,
  shouldUpdateAutomaticSessionTitle,
} from './session-title.js';

test('自动标题清理 Markdown、链接、换行和多余空白', () => {
  assert.equal(
    generateSessionTitle('##  分析   [Relay 项目](https://example.com)\n\n`连续会话` 方案'),
    '分析 Relay 项目 连续会话 方案'
  );
});

test('自动标题按 Unicode 字符截断并保留省略号', () => {
  const title = generateSessionTitle('这是一个用于验证自动会话标题截断行为的非常长的中文问题描述');
  assert.equal(Array.from(title).length, MAX_SESSION_TITLE_LENGTH);
  assert.equal(title.endsWith('…'), true);
});

test('纯确认、继续、选项和标点不触发标题更新', () => {
  for (const content of [
    '好的', '可以。', '继续', '接着来！', '1', '选第二个', ' ？！ ',
    '同意', '同意这个方案。', '很棒', '太棒了！', '真不错', '完美', '赞',
    '是的', '没错', '就按这个来', '谢谢，辛苦了', 'great', 'Agreed',
    '同意修正', '同意，修正。', '同意 \n ，修正！！！', '好的，同意修正一下吧', '同意修正这个方案',
  ]) {
    assert.equal(isSubstantiveSessionTitleMessage(content), false, content);
  }
});

test('简短但包含具体任务的消息仍会触发标题更新', () => {
  for (const content of [
    '继续创建文件夹功能', '改成红色', '登录报错', '第二个按钮颜色不对',
    '很棒，把按钮改成圆形', '同意增加手动锁定字段', '可以增加创建目录功能吗',
    '同意修正按钮颜色', '修正登录报错',
  ]) {
    assert.equal(isSubstantiveSessionTitleMessage(content), true, content);
  }
});

test('真实短回复按忽略、上下文和主题三级分类', () => {
  for (const content of ['符合', '合适', '不需要', '符合适']) {
    assert.deepEqual(classifySessionTitleMessage(content), { kind: 'ignore', content: '' }, content);
  }

  for (const content of [
    '合并吧', '处理第一个吧', '检查修改的内容', '再次检查下吧',
    '下面做什么？', '具体修改什么？', '已经重启好了', '分支干净了',
    '刷新后重复仍存在', '等待该恢复任务合并后再实施',
    '那先处理这两个事情吧', '确认提交阶段一代码，仅提交不推送',
    '可以提交主分支代码，和清理功能分支了吧', '之前沟通有个事情要处理',
    '正常字体就行，可以加粗一下', '可以合理换行',
    '好的，那开始走部署上线流程吧', '补充吧', '修改吧',
    '刚才原分支上有几次提交？', '好的， Jenkins 构建部署好了',
    '改成红色',
  ]) {
    assert.equal(classifySessionTitleMessage(content).kind, 'contextual', content);
  }

  for (const content of [
    '登录报错',
    '结构化任务是根据那个表判断开始处理的id的？',
    '增加一个自动审核选项',
  ]) {
    assert.equal(classifySessionTitleMessage(content).kind, 'topic', content);
  }
});

test('混合消息剥离回应前缀并保留后续具体主题', () => {
  assert.deepEqual(
    classifySessionTitleMessage('符合；\n\n增加统一的结构化文件变更报告，这个是在哪块增加？'),
    { kind: 'topic', content: '增加统一的结构化文件变更报告，这个是在哪块增加？' },
  );
  assert.deepEqual(
    classifySessionTitleMessage('同意\n增加统一的结构化文件变更报告'),
    { kind: 'topic', content: '增加统一的结构化文件变更报告' },
  );
  assert.deepEqual(
    classifySessionTitleMessage('同意，开发模式会有地方标志出来吗？'),
    { kind: 'topic', content: '开发模式会有地方标志出来吗？' },
  );
  assert.deepEqual(
    classifySessionTitleMessage('这个可以，需要补充到规则文件吗'),
    { kind: 'topic', content: '需要补充到规则文件吗' },
  );
  assert.deepEqual(
    classifySessionTitleMessage('同意增加手动锁定字段'),
    { kind: 'topic', content: '增加手动锁定字段' },
  );
  assert.deepEqual(
    classifySessionTitleMessage('可以增加创建目录功能吗'),
    { kind: 'topic', content: '增加创建目录功能吗' },
  );
});

test('上下文型消息只可作为新会话弱回退，主题型可持续更新', () => {
  assert.equal(shouldUpdateAutomaticSessionTitle('新对话', 'contextual'), true);
  assert.equal(shouldUpdateAutomaticSessionTitle('已有自动标题', 'contextual'), false);
  assert.equal(shouldUpdateAutomaticSessionTitle('已有自动标题', 'ignore'), false);
  assert.equal(shouldUpdateAutomaticSessionTitle('已有自动标题', 'topic'), true);
});

test('样式和短指令规则不会吞掉带明确对象或故障的主题', () => {
  for (const content of [
    '字体渲染错误需要修改',
    '颜色显示异常需要修改',
    '改成按钮红色',
    '改成圆形按钮',
  ]) {
    assert.equal(classifySessionTitleMessage(content).kind, 'topic', content);
  }
});

test('句号、问号和感叹号后的具体内容可剥离回应前缀', () => {
  for (const [content, expected] of [
    ['符合。增加自动审核选项', '增加自动审核选项'],
    ['同意！增加自动审核选项', '增加自动审核选项'],
    ['好的。登录按钮报错', '登录按钮报错'],
    ['符合？那就增加自动审核选项', '那就增加自动审核选项'],
  ]) {
    assert.deepEqual(classifySessionTitleMessage(content), { kind: 'topic', content: expected }, content);
  }
});

test('多段消息跳过通用引导标题并选择后续具体主题', () => {
  for (const [content, expected] of [
    ['问题如下：\n登录按钮点击报错', '登录按钮点击报错'],
    ['需求：\n增加自动审核选项', '增加自动审核选项'],
    ['另外注意：\n项目删除时清理规则', '项目删除时清理规则'],
  ]) {
    assert.deepEqual(classifySessionTitleMessage(content), { kind: 'topic', content: expected }, content);
  }
});

test('单字符选项和纯寒暄不触发标题更新', () => {
  for (const content of [
    'A', 'a', 'B', '错',
    '你好', '你好啊', '你好呀！', '你好啊1',
  ]) {
    assert.deepEqual(classifySessionTitleMessage(content), { kind: 'ignore', content: '' }, content);
  }
});

test('双字符短消息只作为新会话标题兜底', () => {
  for (const content of ['授权', '升级', '保持', '接受', '清理', '删除', '休息', '正常', '成功']) {
    assert.equal(classifySessionTitleMessage(content).kind, 'contextual', content);
  }
});

test('下一步变体、完成反馈和确认动作不覆盖已有标题', () => {
  for (const content of [
    '下一步呢？', '接下来呢', '然后呢？',
    '界面OK了', '我已经重启了', '重启后显示OK了', '操作完了', '都正常了', '测试ok',
    '确认登记', '确认克隆', '确认发布', '确认部署', '确认修改规则', '同意执行', '允许删除',
  ]) {
    assert.equal(classifySessionTitleMessage(content).kind, 'contextual', content);
  }
});

test('无对象短动作降级为上下文消息，纯选项继续忽略', () => {
  for (const content of [
    '清理吧', '补上吧', '发布吧', '落地吧', '配置吧', '修正下吧', '继续优化吧',
  ]) {
    assert.equal(classifySessionTitleMessage(content).kind, 'contextual', content);
  }
  assert.deepEqual(classifySessionTitleMessage('第一个吧'), { kind: 'ignore', content: '' });
});

test('短消息过滤保留明确对象、故障和否定状态', () => {
  for (const content of [
    '白屏', '黑屏', '崩溃', '闪退', '报错', '错误', '异常', '失败', '卡死', '死机',
    '乱码', '超时', '宕机', '断连', '中断', '离线',
    '登录报错', '按钮闪退', '清理缓存吧', '发布新版本吧', '配置数据库吧',
    '修正登录报错', '继续优化登录页面', '界面还是不正常', '重启后仍然报错', '测试失败',
  ]) {
    assert.equal(classifySessionTitleMessage(content).kind, 'topic', content);
  }
});
