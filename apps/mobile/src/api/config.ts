import { Platform } from 'react-native';
import { PACKAGED_API_BASE, PACKAGED_WEB_API_BASE } from './api.endpoint';

/**
 * 后端 API 根路径（含 /api）。
 * 打包前由 scripts/mobile 根据 mobile.conf 写入 api.endpoint.ts；
 * 本地调试也可直接改 api.endpoint.ts。
 */
export const API_BASE =
  Platform.OS === 'web'
    ? PACKAGED_WEB_API_BASE || PACKAGED_API_BASE
    : PACKAGED_API_BASE;
