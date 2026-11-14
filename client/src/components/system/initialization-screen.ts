export type InitializationStage = 'auth' | 'page';

export const INITIALIZATION_LOADING_DELAY_MS = 200;

const STAGE_PRESENTATION: Record<InitializationStage, { title: string; detail: string }> = {
  auth: {
    title: '正在启动 Relay…',
    detail: '正在确认当前设备的登录状态',
  },
  page: {
    title: '正在加载页面',
    detail: '正在准备聊天界面资源',
  },
};

export function getInitializationStagePresentation(stage: InitializationStage) {
  return STAGE_PRESENTATION[stage];
}
