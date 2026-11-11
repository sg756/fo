import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { AuthScreen } from '../screens/AuthScreen';
import { HomeScreen } from '../screens/HomeScreen';
import { MarketScreen } from '../screens/MarketScreen';
import { TradeScreen } from '../screens/TradeScreen';
import { MeScreen } from '../screens/MeScreen';
import { AddCoinScreen } from '../screens/AddCoinScreen';
import { HoldingsScreen } from '../screens/HoldingsScreen';
import { RechargeScreen } from '../screens/RechargeScreen';
import { RechargeSuccessScreen } from '../screens/RechargeSuccessScreen';
import { ProfitRecordsScreen } from '../screens/ProfitRecordsScreen';
import { TradeLogScreen } from '../screens/TradeLogScreen';
import { OrderDetailScreen } from '../screens/OrderDetailScreen';
import { CommissionScreen } from '../screens/CommissionScreen';
import { TradeSettingsScreen } from '../screens/TradeSettingsScreen';
import { ExchangeApiScreen } from '../screens/ExchangeApiScreen';
import { StartTradingScreen } from '../screens/StartTradingScreen';
import { PositionsScreen } from '../screens/PositionsScreen';
import { OpenOrdersScreen } from '../screens/OpenOrdersScreen';
import { MyWalletScreen } from '../screens/MyWalletScreen';
import { FundFlowScreen } from '../screens/FundFlowScreen';
import { WithdrawScreen } from '../screens/WithdrawScreen';
import { InviteScreen } from '../screens/InviteScreen';
import { DownlineScreen } from '../screens/DownlineScreen';
import { SecurityScreen } from '../screens/SecurityScreen';
import { ChangePasswordScreen } from '../screens/ChangePasswordScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { HelpScreen } from '../screens/HelpScreen';
import { NoticesScreen } from '../screens/NoticesScreen';
import { useAuth } from '../auth/AuthContext';
import { AccountApi } from '../api/endpoints';
import type { MainTabParamList, RootStackParamList } from './types';

const Tab = createBottomTabNavigator<MainTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

const TAB_ICON_SIZE = 22;

function TabItem({
  icon,
  label,
  color,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  color: string;
}) {
  return (
    <View style={tabStyles.item}>
      <Ionicons name={icon} size={TAB_ICON_SIZE} color={color} />
      <Text style={[tabStyles.label, { color }]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function MainTabs() {
  const { theme } = useTheme();
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, 10);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const r = await AccountApi.noticeUnread();
        if (!stop) setUnread(Number(r.unread) || 0);
      } catch {
        if (!stop) setUnread(0);
      }
    };
    load();
    const timer = setInterval(load, 20000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
        tabBarShowLabel: false,
        tabBarStyle: {
          backgroundColor: theme.tabBar,
          borderTopColor: theme.border,
          height: 60 + bottomPad,
          paddingTop: 6,
          paddingBottom: bottomPad,
        },
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.textSecondary,
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarIcon: ({ color }) => <TabItem icon="home-outline" label="首页" color={color} />,
        }}
      />
      <Tab.Screen
        name="Trade"
        component={TradeScreen}
        options={{
          tabBarIcon: ({ color }) => <TabItem icon="stats-chart-outline" label="交易" color={color} />,
        }}
      />
      <Tab.Screen
        name="Me"
        component={MeScreen}
        options={{
          tabBarBadge: unread > 0 ? unread : undefined,
          tabBarBadgeStyle: { backgroundColor: theme.danger, fontSize: 10 },
          tabBarIcon: ({ color }) => <TabItem icon="person-outline" label="我的" color={color} />,
        }}
      />
    </Tab.Navigator>
  );
}

const tabStyles = StyleSheet.create({
  item: {
    width: 64,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 11,
    lineHeight: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 2,
  },
});

export function RootNavigator() {
  const { theme, themeName } = useTheme();
  const { authed, booting } = useAuth();

  const navTheme = {
    ...(themeName === 'dark' ? DarkTheme : DefaultTheme),
    colors: {
      ...(themeName === 'dark' ? DarkTheme.colors : DefaultTheme.colors),
      background: theme.bg,
      card: theme.card,
      text: theme.text,
      border: theme.border,
      primary: theme.primary,
    },
  };

  if (booting) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.primary} size="large" />
      </View>
    );
  }

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
        {!authed ? (
          <Stack.Screen name="Auth" component={AuthScreen} />
        ) : (
          <>
            <Stack.Screen name="Main" component={MainTabs} />
            <Stack.Screen name="Market" component={MarketScreen} />
            <Stack.Screen name="AddCoin" component={AddCoinScreen} />
            <Stack.Screen name="Holdings" component={HoldingsScreen} />
            <Stack.Screen name="Recharge" component={RechargeScreen} />
            <Stack.Screen name="RechargeSuccess" component={RechargeSuccessScreen} />
            <Stack.Screen name="ProfitRecords" component={ProfitRecordsScreen} />
            <Stack.Screen name="TradeLog" component={TradeLogScreen} />
            <Stack.Screen name="OrderDetail" component={OrderDetailScreen} />
            <Stack.Screen name="Commission" component={CommissionScreen} />
            <Stack.Screen name="TradeSettings" component={TradeSettingsScreen} />
            <Stack.Screen name="ExchangeApi" component={ExchangeApiScreen} />
            <Stack.Screen name="StartTrading" component={StartTradingScreen} />
            <Stack.Screen name="Positions" component={PositionsScreen} />
            <Stack.Screen name="OpenOrders" component={OpenOrdersScreen} />
            <Stack.Screen name="MyWallet" component={MyWalletScreen} />
            <Stack.Screen name="FundFlow" component={FundFlowScreen} />
            <Stack.Screen name="Withdraw" component={WithdrawScreen} />
            <Stack.Screen name="Invite" component={InviteScreen} />
            <Stack.Screen name="Downlines" component={DownlineScreen} />
            <Stack.Screen name="Security" component={SecurityScreen} />
            <Stack.Screen name="ChangePassword" component={ChangePasswordScreen} />
            <Stack.Screen name="Settings" component={SettingsScreen} />
            <Stack.Screen name="Help" component={HelpScreen} />
            <Stack.Screen name="Notices" component={NoticesScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
