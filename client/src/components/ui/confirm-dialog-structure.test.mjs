import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const component = await readFile(new URL('ConfirmDialog.tsx', import.meta.url), 'utf8');
const styles = readStyleSource();

test('通用确认弹窗提供对象、影响和提示的结构化层级', () => {
  assert.match(component, /type ConfirmDialogTone = 'neutral' \| 'warning' \| 'danger'/);
  assert.match(component, /interface ConfirmDialogSubject/);
  assert.match(component, /interface ConfirmDialogNotice/);
  assert.match(component, /subject\?: ConfirmDialogSubject/);
  assert.match(component, /impacts\?: ReactNode\[\]/);
  assert.match(component, /notice\?: ConfirmDialogNotice/);
  assert.match(component, /eyebrow\?: string/);
  assert.match(component, /cancelLabel\?: string \| null/);
  assert.match(component, /confirm-dialog__subject/);
  assert.match(component, /confirm-dialog__impacts/);
  assert.match(component, /confirm-dialog__notice/);
});

test('确认弹窗支持单按钮提示模式并把焦点移到主按钮', () => {
  assert.match(component, /\{cancelLabel && <button/);
  assert.match(component, /data-autofocus=\{cancelLabel \? undefined : true\}/);
  assert.match(component, /\{eyebrow\}/);
  assert.match(component, /confirm-dialog__actions--single/);
  assert.match(styles, /\.confirm-dialog__actions--single \.confirm-dialog__button \{ grid-column: 1 \/ -1; \}/);
});

test('确认弹窗区分中性、警告和危险操作并保留安全焦点', () => {
  assert.match(component, /tone = 'neutral'/);
  assert.match(component, /confirm-dialog--\$\{tone\}/);
  assert.match(component, /data-autofocus/);
  assert.match(component, /role="alertdialog"/);
  assert.match(styles, /\.confirm-dialog--neutral/);
  assert.match(styles, /\.confirm-dialog--warning/);
  assert.match(styles, /\.confirm-dialog--danger/);
  assert.match(styles, /\.confirm-dialog__button--primary/);
  assert.match(component, /M12 3\.75 21 20\.25H3L12 3\.75Z/);
  assert.match(component, /M7\.5 3h9L21 7\.5v9L16\.5 21h-9L3 16\.5v-9L7\.5 3Z/);
});

test('确认弹窗使用更宽的桌面布局并适配移动端和减少动态效果', () => {
  assert.match(styles, /\.confirm-dialog \{[\s\S]*?width: min\(28rem, calc\(100vw - 2rem\)\);/);
  assert.match(styles, /\.confirm-dialog \{[\s\S]*?display: flex;[\s\S]*?max-height: min\(44rem, calc\(100dvh - 2rem\)\);[\s\S]*?flex-direction: column;/);
  assert.match(styles, /\.confirm-dialog__header \{[\s\S]*?flex: 0 0 auto;/);
  assert.match(styles, /\.confirm-dialog__body \{[\s\S]*?min-height: 0;[\s\S]*?overflow-y: auto;/);
  assert.match(styles, /\.confirm-dialog__actions \{[\s\S]*?flex: 0 0 auto;/);
  assert.match(styles, /\.confirm-dialog__subject-value \{[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(styles, /@media \(max-width: 639px\) \{[\s\S]*?\.confirm-dialog \{[\s\S]*?max-height: calc\(100dvh - 1rem\);/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.confirm-dialog/);
  assert.doesNotMatch(styles, /\.confirm-dialog[^}]*background:\s*(?:#fff|white|#000|black)/i);
});
