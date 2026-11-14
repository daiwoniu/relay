export function getLoginErrorMessage(status: number, payload: unknown): string {
  if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string') {
    return payload.error;
  }
  if (status === 0) return '无法连接 Relay，请检查服务是否已启动';
  return '登录服务暂时不可用，请稍后重试';
}

export function getInitialAuthFailureState(status: number): 'guest' | 'error' {
  return status === 401 ? 'guest' : 'error';
}
