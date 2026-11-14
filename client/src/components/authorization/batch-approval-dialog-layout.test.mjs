import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const dialog = fs.readFileSync(new URL('./BatchApprovalDialog.tsx', import.meta.url), 'utf8');
const styles = readStyleSource();

test('批量授权弹窗使用审阅台信息层级并保留状态反馈', () => {
  assert.match(dialog, /batch-approval-dialog--\$\{presentation\.tone\}/);
  assert.match(dialog, /batch-approval-dialog__hero/);
  assert.match(dialog, /batch-approval-dialog__metric/);
  assert.match(dialog, /请求数量/);
  assert.match(dialog, /涉及会话/);
  assert.match(dialog, /逐项提交/);
  assert.match(dialog, /batch-approval-dialog__review/);
  assert.match(dialog, /batch-approval-dialog__group/);
  assert.match(dialog, /presentation\.icon === 'accept'/);
  assert.match(dialog, /presentation\.icon === 'warning'/);
  assert.doesNotMatch(dialog, /excludedCancelCount|批量拒绝/);
  assert.match(dialog, /batch-approval-dialog__request-title">\{item\.purpose\}/);
  assert.match(dialog, /batch-approval-dialog__request-summary">\{item\.typeLabel\} · \{item\.summary\}/);
  assert.match(dialog, /batch-approval-dialog__footer/);
  assert.match(dialog, /presentation\.confirmLabel/);
  assert.match(dialog, /aria-live="polite"/);
  assert.match(dialog, /batch-approval-dialog__progress/);
  assert.match(dialog, /batch-approval-dialog__result/);
  assert.match(dialog, /batch-approval-dialog__actions--single/);
});

test('批量授权弹窗样式适配桌面、移动、多主题和减少动态效果', () => {
  assert.match(styles, /\.batch-approval-dialog \{[\s\S]*?width: min\(38rem, calc\(100vw - 2rem\)\);/);
  assert.match(styles, /\.batch-approval-dialog--accept \{[\s\S]*?--batch-approval-accent: var\(--color-status-processing\);/);
  assert.match(styles, /\.batch-approval-dialog--success \{[\s\S]*?--batch-approval-accent: var\(--color-status-success\);/);
  assert.match(styles, /\.batch-approval-dialog--partial \{[\s\S]*?--batch-approval-accent: var\(--color-status-warning\);/);
  assert.match(styles, /\.batch-approval-dialog__review \{[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.batch-approval-dialog__request-copy \{[\s\S]*?flex-direction: column;/);
  assert.match(styles, /\.batch-approval-dialog__request-title \{[\s\S]*?color: var\(--color-text\);[\s\S]*?font-size: 0\.75rem;[\s\S]*?font-weight: 600;/);
  assert.match(styles, /\.batch-approval-dialog__request-summary \{[\s\S]*?color: var\(--color-text-tertiary\);[\s\S]*?font-size: 0\.6875rem;/);
  assert.match(styles, /\.batch-approval-dialog__footer \{[\s\S]*?flex: 0 0 auto;/);
  assert.match(styles, /@media \(max-width: 639px\) \{[\s\S]*?\.batch-approval-dialog \{[\s\S]*?height: min\(88dvh, 46rem\);/);
  assert.match(styles, /padding-bottom: calc\(0\.875rem \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(styles, /\.batch-approval-dialog__actions--single \.batch-approval-dialog__button \{[\s\S]*?grid-column: 1 \/ -1;/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.batch-approval-dialog/);
  assert.doesNotMatch(styles, /\.batch-approval-dialog[^}]*background:\s*(?:#fff|white|#000|black)/i);
});
