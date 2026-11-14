import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { extractMarkdownCodeText } from './markdown-code-text.ts';

const assistantSource = await readFile(new URL('./AssistantMessage.tsx', import.meta.url), 'utf8');

const sql = `CREATE TABLE \`t_icbc_courtnotice_structure_change\` (
  \`id\` bigint(20) NOT NULL AUTO_INCREMENT COMMENT '自增主键，同时作为951消费游标',
  \`source_change_id\` bigint(20) DEFAULT NULL COMMENT '来源change主键，阶段一老DS链路允许为空',
  \`cn_id\` bigint(20) NOT NULL COMMENT '工行客户ID',
  \`op_type\` char(1) NOT NULL COMMENT '操作类型：I新增、U更新、D删除',
  \`old_role_count\` int(11) NOT NULL DEFAULT '0' COMMENT '结构化前角色数量',
  \`new_role_count\` int(11) NOT NULL DEFAULT '0' COMMENT '结构化后角色数量',
  \`create_time\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  PRIMARY KEY (\`id\`),
  KEY \`idx_cn_id_id\` (\`cn_id\`, \`id\`),
  KEY \`idx_source_change_id\` (\`source_change_id\`),
  KEY \`idx_create_time\` (\`create_time\`)
) ENGINE=InnoDB
  DEFAULT CHARSET=utf8
  COLLATE=utf8_general_ci
  COMMENT='工行开庭公告结构化完成事件';`;

test('SQL 高亮节点提取后保持原始代码文本且不产生 object Object', () => {
  const markdown = `外网地址：

\`\`\`text
106.75.49.233:7749/icbc
\`\`\`

要执行的 SQL：

\`\`\`sql
${sql}
\`\`\``;
  const extracted = [];
  const html = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeHighlight],
    components: {
      code({ node, children, className }) {
        const code = extractMarkdownCodeText(node, children).replace(/\n$/, '');
        extracted.push(code);
        return React.createElement('code', { className }, children);
      },
    },
    children: markdown,
  }));

  assert.deepEqual(extracted, ['106.75.49.233:7749/icbc', sql]);
  assert.doesNotMatch(html, /\[object Object\]/);
  assert.match(html, /class="hljs-keyword"/);
});

test('没有 AST 节点时也能无分隔符拼接嵌套 React children', () => {
  const children = [
    React.createElement('span', { key: 'keyword' }, 'CREATE TABLE'),
    ' ',
    React.createElement('span', { key: 'name' }, '`table_name`'),
  ];
  assert.equal(extractMarkdownCodeText(undefined, children), 'CREATE TABLE `table_name`');

  const repeated = React.createElement('span', null, 'id');
  assert.equal(extractMarkdownCodeText(undefined, [repeated, '+', repeated]), 'id+id');
});

test('代码块复制使用非安全上下文兼容函数并处理失败', () => {
  assert.match(assistantSource, /copyToClipboard\(code\)/);
  assert.match(assistantSource, /copyToClipboard\(code\)[\s\S]*?\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(assistantSource, /navigator\.clipboard\.writeText\(code\)/);
});
