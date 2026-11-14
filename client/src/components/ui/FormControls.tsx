import type { ReactNode } from 'react';
import FailureNotice from './FailureNotice';

export const formControlClassName = 'ui-form-control';
export const formSelectClassName = 'ui-form-control ui-form-select';
export const formRangeClassName = 'ui-form-range';
export const formColorClassName = 'ui-form-color';
export const formCheckboxClassName = 'ui-form-checkbox';
export const formCheckboxCardClassName = 'ui-form-checkbox-card';
export const formSegmentedClassName = 'ui-form-segmented';
export const formSegmentedOptionClassName = 'ui-form-segmented__option';
export const primaryFormButtonClassName = 'ui-form-button ui-form-button--primary';
export const secondaryFormButtonClassName = 'ui-form-button ui-form-button--secondary';
export const textFormButtonClassName = 'ui-form-button ui-form-button--text';
export const formActionsClassName = 'ui-form-actions';

export function FormField({ label, children, hint, className = '' }: {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return <label className={`ui-form-field ${className}`.trim()}>
    <span className="ui-form-field__label">{label}</span>
    {children}
    {hint && <span className="ui-form-field__hint">{hint}</span>}
  </label>;
}

export function FormFeedback({ message, error = false, className = '' }: {
  message?: ReactNode;
  error?: boolean;
  className?: string;
}) {
  const tone = error ? 'danger' : message ? 'success' : 'neutral';
  return <span
    role={error ? 'alert' : 'status'}
    aria-live={error ? 'assertive' : 'polite'}
    className={`ui-form-feedback ui-form-feedback--${tone} ${className}`.trim()}
  >{error && typeof message === 'string' && message ? <FailureNotice error={message} /> : message}</span>;
}
