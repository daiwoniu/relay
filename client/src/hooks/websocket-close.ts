export const AUTHENTICATION_CLOSE_CODE = 1008;

export function isAuthenticationClose(code: number): boolean {
  return code === AUTHENTICATION_CLOSE_CODE;
}
