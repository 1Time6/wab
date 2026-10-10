// 必须在 import wa-js 之前执行：关闭统计上报，不向手机端发任何状态
(globalThis as unknown as { WPPConfig: Record<string, unknown> }).WPPConfig = {
  poweredBy: 'WAB',
  disableGoogleAnalytics: true,
  sendStatusToDevice: false,
  syncAllStatus: false,
};
