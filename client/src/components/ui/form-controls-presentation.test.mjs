import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { readStyleSource } from '../../styles/style-source.test-helper.mjs';

const component = await readFile(new URL('./FormControls.tsx', import.meta.url), 'utf8');
const styles = readStyleSource();

test('主题兼容层提供表单所需的稳定语义 token', () => {
  for (const token of [
    '--theme-surface-page', '--theme-surface-content', '--theme-surface-control', '--theme-surface-raised',
    '--theme-border-default', '--theme-border-subtle', '--theme-text-primary', '--theme-text-secondary',
    '--theme-text-tertiary', '--theme-brand', '--theme-focus-ring',
  ]) assert.match(styles, new RegExp(`${token}:\\s*var\\(--color-`), token);
  assert.match(styles, /:root \{[\s\S]*--theme-on-primary:\s*#ffffff/);
  assert.match(styles, /:root\[data-theme='dark'\] \{[\s\S]*--theme-on-primary:\s*#181818/);
  assert.doesNotMatch(styles, /--theme-on-primary:\s*var\(--color-bg\)/);
});

test('共享表单原语覆盖字段、提示、反馈和主次操作', () => {
  assert.match(component, /export function FormField/);
  assert.match(component, /ui-form-field__label/);
  assert.match(component, /ui-form-field__hint/);
  assert.match(component, /export function FormFeedback/);
  assert.match(component, /role=\{error \? 'alert' : 'status'\}/);
  assert.match(component, /aria-live=\{error \? 'assertive' : 'polite'\}/);
  assert.match(component, /export const formControlClassName = 'ui-form-control'/);
  assert.match(component, /export const primaryFormButtonClassName = 'ui-form-button ui-form-button--primary'/);
  assert.match(component, /export const secondaryFormButtonClassName = 'ui-form-button ui-form-button--secondary'/);
});

test('共享表单原语覆盖复杂控件与任务操作区', () => {
  assert.match(component, /export const formSelectClassName = 'ui-form-control ui-form-select'/);
  assert.match(component, /export const formRangeClassName = 'ui-form-range'/);
  assert.match(component, /export const formColorClassName = 'ui-form-color'/);
  assert.match(component, /export const formCheckboxClassName = 'ui-form-checkbox'/);
  assert.match(component, /export const formCheckboxCardClassName = 'ui-form-checkbox-card'/);
  assert.match(component, /export const formSegmentedClassName = 'ui-form-segmented'/);
  assert.match(component, /export const formSegmentedOptionClassName = 'ui-form-segmented__option'/);
  assert.match(component, /export const textFormButtonClassName = 'ui-form-button ui-form-button--text'/);
  assert.match(component, /export const formActionsClassName = 'ui-form-actions'/);
});

test('表单控件统一 focus disabled 状态并保护移动端命中区', () => {
  assert.match(styles, /\.ui-form-control:focus-visible/);
  assert.match(styles, /\.ui-form-button:has\(input:focus-visible\)/);
  assert.match(styles, /\.ui-form-(?:control|button):disabled[\s\S]*cursor: not-allowed/);
  assert.match(styles, /\.ui-form-feedback \{[\s\S]*display: block/);
  assert.match(styles, /\.ui-form-feedback--danger/);
  assert.match(styles, /\.ui-form-feedback--success/);
  assert.match(styles, /@media \(max-width: 1023px\)\s*\{[^}]*\.ui-form-button\s*\{[^}]*min-height:\s*2\.75rem/);
  assert.doesNotMatch(styles, /@media \(max-width: 639px\)\s*\{[^}]*\.ui-form-button\s*\{[^}]*min-height:\s*2\.75rem/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.ui-form-control/);
});

test('复杂表单控件统一选中、焦点、禁用与触控状态', () => {
  assert.match(styles, /\.ui-form-select/);
  assert.match(styles, /\.ui-form-range:focus-visible/);
  assert.match(styles, /\.ui-form-color:focus-visible/);
  assert.match(styles, /\.ui-form-checkbox:focus-visible/);
  assert.match(styles, /\.ui-form-checkbox-card:has\(input:focus-visible\)/);
  assert.match(styles, /\.ui-form-checkbox-card\.is-selected/);
  assert.match(styles, /\.ui-form-segmented__option\.is-selected/);
  assert.match(styles, /\.ui-form-segmented__option:focus-visible/);
  assert.match(styles, /\.ui-form-segmented--fill\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.ui-form-file-button\s*\{[^}]*min-height:\s*3\.25rem[^}]*border-style:\s*dashed/);
  assert.match(styles, /\.ui-form-button--text/);
  assert.match(styles, /\.ui-form-actions/);
  assert.match(styles, /@media \(max-width: 1023px\)\s*\{\s*\.ui-form-button\s*\{[^}]*min-height:\s*2\.75rem[^}]*\}\s*\.ui-form-color\s*\{[^}]*min-height:\s*2\.75rem[^}]*\}\s*\.ui-form-segmented__option\s*\{[^}]*min-height:\s*2\.75rem[^}]*\}\s*\}/);
});
