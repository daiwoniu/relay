import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeCodexFileReference,
  encodeCodexFileReference,
  parseCodexDirective,
  resolveCodexFileReferencePathResult,
  resolveCodexFileReferencePath,
  remarkCodexFileDirectives,
} from './codex-file-directives.ts';

test('解析三种 Codex 文件指令并生成目标路径', () => {
  assert.deepEqual(
    parseCodexDirective(':codex-file-citation{path="D:\\work\\report.docx" purpose="output" artifact_kind="document" page_number="4"}'),
    {
      kind: 'file',
      path: 'D:\\work\\report.docx',
      label: 'report.docx',
      locator: '第 4 页',
      preferredMode: 'source',
    },
  );
  assert.deepEqual(
    parseCodexDirective('::codex-inline-vis{file="charts/summary.html"}'),
    {
      kind: 'visualization',
      path: 'charts/summary.html',
      label: 'summary.html',
      preferredMode: 'visualization',
    },
  );
  assert.deepEqual(
    parseCodexDirective('::artifact-template{skill_name="artifact-template-brief" skill_directory="C:\\skills\\brief" display_name="项目简报" artifact_kind="document"}'),
    {
      kind: 'template',
      path: 'C:\\skills\\brief\\SKILL.md',
      label: '项目简报',
      preferredMode: 'source',
    },
  );
});

test('支持行号定位并拒绝缺失目标、未知字段和未加引号属性', () => {
  assert.equal(
    parseCodexDirective(':codex-file-citation{path="src/app.ts" line_start="12" line_end="18"}')?.locator,
    '第 12–18 行',
  );
  assert.equal(parseCodexDirective(':codex-file-citation{purpose="output"}'), null);
  assert.equal(parseCodexDirective('::codex-inline-vis{file=demo.html}'), null);
  assert.equal(parseCodexDirective('::codex-inline-vis{file="demo.html" title="标题"}'), null);
  assert.equal(parseCodexDirective('::future-directive{file="demo.html"}'), null);
  assert.equal(
    parseCodexDirective(String.raw`:codex-file-citation{path="\\server\share\report.pdf" purpose="source"}`)?.path,
    String.raw`\\server\share\report.pdf`,
  );
});

test('支持演示文稿和工作簿的官方定位字段', () => {
  assert.equal(
    parseCodexDirective(':codex-file-citation{path="deck.pptx" purpose="source" artifact_kind="presentation" slide_number="3" slide_id="sl/abc" object_id="ch/def" label="ARR by segment chart"}')?.locator,
    '第 3 张幻灯片 · ARR by segment chart',
  );
  assert.equal(
    parseCodexDirective(':codex-file-citation{path="book.xlsx" purpose="source" artifact_kind="workbook" sheet="Revenue Model" range="C27"}')?.locator,
    '工作表“Revenue Model” · C27',
  );
  assert.equal(
    parseCodexDirective(':codex-file-citation{path="book.xlsx" purpose="source" artifact_kind="workbook" sheet="Dashboard" object_id="chart-1" object_kind="chart" label="收入趋势"}')?.locator,
    '工作表“Dashboard” · 收入趋势',
  );
});

test('相对文件引用基于当前会话项目解析，绝对路径保持不变', () => {
  assert.equal(resolveCodexFileReferencePath('charts/summary.html', 'D:\\work\\project'), 'D:\\work\\project\\charts\\summary.html');
  assert.equal(resolveCodexFileReferencePath('reports/summary.html', '/srv/project'), '/srv/project/reports/summary.html');
  assert.equal(resolveCodexFileReferencePath('D:\\shared\\summary.html', 'D:\\work\\project'), 'D:\\shared\\summary.html');
  assert.equal(resolveCodexFileReferencePath('\\\\server\\share\\summary.html', 'D:\\work\\project'), '\\\\server\\share\\summary.html');
  assert.throws(() => resolveCodexFileReferencePath('../secret.html', 'D:\\work\\project'), /当前项目/);
  assert.throws(() => resolveCodexFileReferencePath('summary.html'), /项目路径/);
  assert.deepEqual(resolveCodexFileReferencePathResult('summary.html'), { ok: false, reason: '当前消息缺少项目路径' });
  assert.deepEqual(resolveCodexFileReferencePathResult('../secret.html', 'D:\\work\\project'), { ok: false, reason: '文件路径不在当前项目内' });
  assert.deepEqual(resolveCodexFileReferencePathResult('https://example.com/chart.html', 'D:\\work\\project'), { ok: false, reason: '文件路径协议无效' });
});

test('内部引用链接可以安全往返，损坏载荷不解析', () => {
  const reference = {
    kind: 'visualization',
    path: 'D:\\图表\\经营概览.html',
    label: '经营概览.html',
    preferredMode: 'visualization',
  };
  const encoded = encodeCodexFileReference(reference);
  assert.match(encoded, /^codex-file-ref:/);
  assert.deepEqual(decodeCodexFileReference(encoded), reference);
  assert.equal(decodeCodexFileReference('codex-file-ref:%7Bbroken'), null);
  assert.equal(decodeCodexFileReference('https://example.com'), null);
});

test('Remark 转换内联文件引用和独占双冒号指令', () => {
  const tree = {
    type: 'root',
    children: [
      { type: 'paragraph', children: [{ type: 'text', value: '已生成 :codex-file-citation{path="out/report.pdf" purpose="output"}，请查看。' }] },
      { type: 'paragraph', children: [{ type: 'text', value: '::codex-inline-vis{file="out/chart.html"}' }] },
      { type: 'paragraph', children: [{ type: 'text', value: '前缀 ::codex-inline-vis{file="out/ignored.html"}' }] },
    ],
  };
  remarkCodexFileDirectives()(tree);
  assert.deepEqual(tree.children[0].children.map((node) => node.type), ['text', 'link', 'text']);
  assert.equal(decodeCodexFileReference(tree.children[0].children[1].url)?.path, 'out/report.pdf');
  assert.equal(tree.children[1].children[0].type, 'link');
  assert.equal(decodeCodexFileReference(tree.children[1].children[0].url)?.preferredMode, 'visualization');
  assert.equal(tree.children[2].children[0].type, 'text');
});

test('Remark 不解析代码、行内代码和已有链接', () => {
  const directive = ':codex-file-citation{path="secret.txt" purpose="source"}';
  const tree = {
    type: 'root',
    children: [
      { type: 'code', value: directive },
      { type: 'paragraph', children: [{ type: 'inlineCode', value: directive }] },
      { type: 'paragraph', children: [{ type: 'link', url: '#', children: [{ type: 'text', value: directive }] }] },
    ],
  };
  remarkCodexFileDirectives()(tree);
  assert.equal(tree.children[0].type, 'code');
  assert.equal(tree.children[1].children[0].type, 'inlineCode');
  assert.equal(tree.children[2].children[0].children[0].type, 'text');
});

test('Remark 将 Codex 后续建议转成可读文字并保留文件引用', () => {
  const followup = ':codex-followup[填写合作细节]{prompt="根据我提供的师资人数、服务地点、时间和费用，填写合作协议及附件中的空白项。"}';
  const tree = {
    type: 'root',
    children: [
      { type: 'paragraph', children: [{ type: 'text', value: `建议：${followup}` }] },
      { type: 'paragraph', children: [{ type: 'text', value: '文件 :codex-file-citation{path="out/agreement.docx" purpose="output"}' }] },
      { type: 'paragraph', children: [{ type: 'inlineCode', value: followup }] },
      { type: 'paragraph', children: [{ type: 'text', value: ':codex-followup[损坏]{prompt=未加引号}' }] },
    ],
  };

  remarkCodexFileDirectives()(tree);

  assert.equal(tree.children[0].children.map((node) => node.value || '').join(''), '建议：填写合作细节：根据我提供的师资人数、服务地点、时间和费用，填写合作协议及附件中的空白项。');
  assert.equal(decodeCodexFileReference(tree.children[1].children[1].url)?.path, 'out/agreement.docx');
  assert.equal(tree.children[2].children[0].value, followup);
  assert.equal(tree.children[3].children[0].value, ':codex-followup[损坏]{prompt=未加引号}');
});
