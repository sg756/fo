import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { AccountApi } from '../api/endpoints';

let currentToken = '';

if (Platform.OS === 'ios' || Platform.OS === 'android') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

function projectId(): string {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId || Constants.easConfig?.projectId || '';
}

/** 登录后向服务端登记这台手机。模拟器和拒绝权限时不登记。 */
export async function registerPushToken() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  if (!Device.isDevice) return;
  const { status: existing } = await Notifications.getPermissionsAsync();
  let status = existing;
  if (status !== 'granted') {
    const asked = await Notifications.requestPermissionsAsync();
    status = asked.status;
  }
  if (status !== 'granted') return;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('point-card', {
      name: '点卡提醒',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }
  const id = projectId();
  if (!id) return;
  const token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
  if (!token) return;
  currentToken = token;
  await AccountApi.registerPushToken({ token, platform: Platform.OS });
}

/** 退出登录时卸下令牌。没有令牌则什么都不做。 */
export async function unregisterPushToken() {
  const token = currentToken;
  currentToken = '';
  if (!token) return;
  try {
    await AccountApi.removePushToken(token);
  } catch {
    /* 已退出或网络失败时，下次换号登录会改挂令牌 */
  }
}
