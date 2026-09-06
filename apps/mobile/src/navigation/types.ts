import type { ExchangeCode } from '../api/exchanges';
import type { ProfitItem, RechargeOrder } from '../api/endpoints';
import type { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
  Home: undefined;
  Trade: undefined;
  Me: undefined;
};

export type RootStackParamList = {
  Auth: undefined;
  Main: NavigatorScreenParams<MainTabParamList> | undefined;
  Market: undefined;
  AddCoin: undefined;
  Holdings: undefined;
  Recharge: undefined;
  RechargeSuccess: { order: RechargeOrder };
  ProfitRecords: undefined;
  TradeLog: undefined;
  OrderDetail: { item: ProfitItem; kind: 'profit' | 'follow' };
  Commission: undefined;
  TradeSettings: undefined;
  ExchangeApi: {
    exchange: ExchangeCode;
    name: string;
    needPass: boolean;
    configured: boolean;
    keyId?: string;
    apiKeyMasked?: string;
  };
  StartTrading: undefined;
  Positions: undefined;
  OpenOrders: undefined;
  MyWallet: undefined;
  FundFlow: undefined;
  Withdraw: undefined;
  Invite: undefined;
  Downlines: undefined;
  Security: undefined;
  ChangePassword: undefined;
  Settings: undefined;
  Help: undefined;
};
