import { UserRole } from '../../common/auth-role';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  Allow,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { Exchange } from '@prisma/client';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { TradeService } from './trade.service';
import { FollowerWorker } from './follower.worker';
import { QueryPositionWorker } from './query-position.worker';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';

class PlaceOrderBody {
  @IsEnum(Exchange) exchange: Exchange;
  @IsString() symbol: string;
  @IsString() side: string;
  @IsOptional() @IsString() orderType?: string;
  @IsOptional() @IsString() accountType?: string;
  @IsOptional() @Allow() price?: number | string;
  @Allow() amount: number | string;
  @IsOptional() @IsString() positionSide?: string;
  @IsOptional() @Allow() leverage?: number | string;
  @IsOptional() @IsBoolean() reduceOnly?: boolean;
  @IsOptional() @IsString() clientOrderId?: string;
  @IsOptional() @IsObject() extra?: Record<string, any>;
  @IsOptional() @IsString() tradePassword?: string;
}

class SignalTimeoutDto {
  /** 信号超时毫秒（优先） */
  @IsOptional() @IsNumber() @Min(100) ms?: number;
  /** @deprecated 秒；?ms 时使?*/
  @IsOptional() @IsNumber() @Min(0.1) seconds?: number;
}

class PollMsDto {
  @IsNumber() @Min(100) ms: number;
}

class OrderExpireDto {
  @IsNumber() @Min(1) seconds: number;
}

class ChaseOnExpireDto {
  @IsBoolean() enabled: boolean;
}

class FollowHaltedDto {
  @IsBoolean() halted: boolean;
}

class QueryPositionIntervalDto {
  @IsNumber() @Min(2) minutes: number;
}

class QueryPositionSyncDto {
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsEnum(Exchange) exchange?: Exchange;
}

class MiddlewareConfigDto {
  @IsString() base: string;
  @IsOptional() @IsString() serviceKey?: string;
  /** 跟单信号主账?GID（MultiAccountList.value）；空串清除 */
  @IsOptional() @IsString() accountGid?: string;
  @IsOptional() @IsString() accountName?: string;
}

class OpenMinPointDto {
  @IsNumber() @Min(0) amount: number;
}

class PurgeFollowLogsBody {
  /** all=清空全部；range=按创建At 时间范围 */
  @IsIn(['all', 'range', 'ids'])
  mode!: 'all' | 'range' | 'ids';

  /** ISO ?datetime-local 字符?*/
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ids?: string[];
}

class ManualProfitDto {
  @IsString() userId: string;
  @IsEnum(Exchange) exchange: Exchange;
  @IsString() symbol: string;
  @IsNumber() profit: number;
  @IsOptional() @IsString() orderId?: string;
  @IsOptional() @IsString() signalKey?: string;
}

/** 已实现盈亏公式试?(不入? */
class PreviewPnlDto {
  @IsString() positionSide: string; // long / short
  @IsNumber() openAvg: number;
  @IsNumber() closeAvg: number;
  @IsNumber() qty: number;
  @IsOptional() @IsNumber() openFee?: number;
  @IsOptional() @IsNumber() closeFee?: number;
  @IsOptional() @IsNumber() multiplier?: number;
}

class RetryCancelFailedDto {
  /** 指定 SignalFollowLog.id；空则重试全?CANCEL_FAILED（最?take?*/
  @IsOptional() @IsArray() @IsString({ each: true }) ids?: string[];
  @IsOptional() @IsNumber() @Min(1) take?: number;
}

class AdminCancelOrdersDto {
  @IsArray() @IsString({ each: true }) ids: string[];
}

/** 运营手动撤单测试：交易所 + 交易所订单?*/
class AdminCancelByOrderIdDto {
  @IsEnum(Exchange) exchange: Exchange;
  @IsString() @MinLength(1) orderId: string;
  @IsOptional() @IsString() userId?: string;
  @IsOptional() @IsString() coinName?: string;
  @IsOptional() @IsString() equalCoinName?: string;
  @IsOptional() @IsString() accountType?: string;
}

class AdminClosePositionDto {
  @IsString() userId: string;
  @IsEnum(Exchange) exchange: Exchange;
  @IsString() coinName: string;
  @IsString() positionSide: string;
  @Allow() amount: number | string;
  @IsOptional() @IsString() equalCoinName?: string;
  @IsOptional() @IsString() symbol?: string;
  @IsOptional() @IsString() accountType?: string;
  @IsOptional() @IsString() accountGid?: string;
  @IsOptional() @IsString() accountName?: string;
  @IsOptional() @Allow() leverage?: number | string;
}

/** 仅清除本?OPEN 持仓记录（不打交易所?*/
class AdminDiscardLocalPositionsDto {
  @IsArray()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  ids: string[];
}

class UpsertFollowTemplateDto {
  @IsOptional() @IsString() id?: string;
  @IsString() @MinLength(1) name: string;
  @IsEnum(Exchange) exchange: Exchange;
  /** 中间?MultiAccountList 账户 GUID */
  @IsString() @MinLength(1) accountGid: string;
  /** 中间件账户名称（展示?*/
  @IsOptional() @IsString() accountName?: string;
  /** 单笔最小金?*/
  @IsNumber() @Min(0) unitAmount: number;
  /** 比例基准本金（用户声明投?/ 本?= 开仓比例） */
  @IsNumber() @Min(0) maxPrincipal: number;
  /** 最少投入总本金（用户声明投入下限?=不限制） */
  @IsOptional() @IsNumber() @Min(0) minInvestAmount?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() remark?: string;
}

class UpsertUserFollowConfigDto {
  @IsEnum(Exchange) exchange: Exchange;
  @IsString() @MinLength(1) templateId: string;
  /** 用户声明投入总本金；仅算开仓比例，不校验交易所余额 */
  @IsNumber() @Min(0) investAmount: number;
}

@UseGuards(JwtAuthGuard)
@Controller('trade')
export class TradeController {
  constructor(private trade: TradeService) {}

  @Get('checklist')
  checklist(@CurrentUser('sub') userId: string) {
    return this.trade.checklist(userId);
  }

  @Get('follow-status')
  followStatus(@CurrentUser('sub') userId: string) {
    return this.trade.followStatus(userId);
  }

  /** 用户点击「开始交易」→ 进入跟单?*/
  @Post('start')
  start(@CurrentUser('sub') userId: string) {
    return this.trade.startFollow(userId);
  }

  /** 停止跟单 */
  @Post('stop')
  stop(@CurrentUser('sub') userId: string) {
    return this.trade.stopFollow(userId);
  }

  /** 启用中的跟单模板（App 选择用） */
  @Get('follow-templates')
  listActiveFollowTemplates(@Query('exchange') exchange?: Exchange) {
    return this.trade.listActiveFollowTemplates(exchange);
  }

  /** 用户按交易所的跟单配置（模板 + 声明本金?*/
  @Get('follow-configs')
  listFollowConfigs(@CurrentUser('sub') userId: string) {
    return this.trade.listUserFollowConfigs(userId);
  }

  /** 保存某交易所跟单配置（每所最?1 模板；不校验余额?*/
  @Post('follow-configs')
  upsertFollowConfig(@CurrentUser('sub') userId: string, @Body() dto: UpsertUserFollowConfigDto) {
    return this.trade.upsertUserFollowConfig(userId, dto);
  }

  /** 清除某交易所跟单配置 */
  @Delete('follow-configs/:exchange')
  deleteFollowConfig(@CurrentUser('sub') userId: string, @Param('exchange') exchange: Exchange) {
    if (!Object.values(Exchange).includes(exchange)) {
      throw new BadRequestException('无效交易所');
    }
    return this.trade.deleteUserFollowConfig(userId, exchange);
  }

  @Get('positions')
  positions(@CurrentUser('sub') userId: string) {
    return this.trade.listPositions(userId);
  }

  @Get('orders')
  orders(@CurrentUser('sub') userId: string) {
    return this.trade.listOpenOrders(userId);
  }

  @Get('balance')
  balance(@CurrentUser('sub') userId: string, @Query('exchange') exchange: Exchange) {
    return this.trade.queryBalance(userId, exchange);
  }

  /** 多交易所余额汇?+ USDT 折算 */
  @Get('balances')
  balances(@CurrentUser('sub') userId: string) {
    return this.trade.listBalances(userId);
  }

  /** 首页聚合: 收益统计 / 点卡 / 资产 */
  @Get('home-summary')
  homeSummary(@CurrentUser('sub') userId: string) {
    return this.trade.homeSummary(userId);
  }

  /** 平仓收益记录 */
  @Get('profits')
  profits(
    @CurrentUser('sub') userId: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
    @Query('exchange') exchange?: string,
    @Query('coin') coin?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.trade.listProfits(userId, Number(skip), Number(take), {
      exchange,
      coin,
      from,
      to,
    });
  }

  /** 跟单历史订单 */
  @Get('follow-history')
  followHistory(
    @CurrentUser('sub') userId: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.trade.listFollowHistory(userId, Number(skip), Number(take));
  }

  @Post('place-order')
  place(@CurrentUser('sub') userId: string, @Body() dto: PlaceOrderBody) {
    return this.trade.placeOrder(userId, dto as any);
  }

  @Get('depth')
  depth(@Query('symbol') symbol: string, @Query('exchange') exchange?: Exchange) {
    return this.trade.getDepth(symbol, exchange);
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/trade')
export class TradeAdminController {
  constructor(
    private trade: TradeService,
    private follower: FollowerWorker,
    private queryPos: QueryPositionWorker,
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /** 主账户最近委?= 跟单信号?*/
  @Get('last-order-records')
  lastOrders() {
    return this.trade.lastOrderRecords();
  }

  /**
   * 管理端：用户交易所资产（合?现货/资金等），按需查询中间?QueryBalance?   */
  @Get('users/:userId/balances')
  userExchangeBalances(@Param('userId') userId: string) {
    return this.trade.listUserExchangeBalances(userId);
  }

  /** 中间件基础地址 / ServiceKey (文档 http://域名或公网IP:1820/) */
  @Get('middleware/config')
  middlewareConfig() {
    return this.trade.getMiddlewareConfig();
  }

  @Post('middleware/config')
  async setMiddlewareConfig(@Body() dto: MiddlewareConfigDto, @CurrentUser('sub') actorId: string) {
    const res = await this.trade.setMiddlewareConfig({
      base: dto.base,
      serviceKey: dto.serviceKey,
      accountGid: dto.accountGid,
      accountName: dto.accountName,
    });
    await this.audit.log({
      actorId,
      action: 'MIDDLEWARE_CONFIG_UPDATE',
      detail: {
        base: res.base,
        serviceKeyFromDb: res.serviceKeyFromDb,
        serviceKeyConfigured: res.serviceKeyConfigured,
        accountGid: res.accountGid,
        accountName: res.accountName,
      },
    });
    return res;
  }

  /** 中间件连通性测?(mapi/Test) */
  @Get('middleware/test')
  middlewareTest() {
    return this.trade.middlewareTest();
  }

  /** 主账户列表：默认只读 1 分钟缓存；force=1 才同步刷新 */
  @Get('middleware/accounts')
  middlewareAccounts(@Query('force') force?: string) {
    return this.trade.multiAccountList({
      force: force === '1' || force === 'true',
    });
  }

  /** 交易对规范列?(mapi/CryptoSymbolList, force=1 强制刷新缓存) */
  @Get('middleware/symbols')
  middlewareSymbols(@Query('force') force?: string) {
    return this.trade.cryptoSymbolList(force === '1' || force === 'true');
  }

  /** 中间件公共代理列?(mapi/PublicHttpProxyList) */
  @Get('middleware/proxies')
  middlewareProxies(@Query('force') force?: string) {
    return this.trade.publicHttpProxyList({
      force: force === '1' || force === 'true',
    });
  }

  /** 跟单信号预览：直?LastOrderRecords（账号列表内）；不触发下?*/
  @Get('follower/signals')
  followerSignals() {
    return this.follower.previewSignals();
  }

  /** 手动跑一轮信号采集跟?*/
  @Post('follower/run-once')
  runOnce() {
    return this.follower.runOnce();
  }

  /** 跟单采集配置 */
  @Get('follower/config')
  async followerConfig() {
    const cfg = await this.follower.getConfig();
    const qp = await this.queryPos.publicConfig();
    return { ...cfg, ...qp };
  }

  /** 设置信号超时毫秒 (默认 60000；也可传 seconds 兼容旧客户端) */
  @Post('follower/signal-timeout')
  async setSignalTimeout(@Body() dto: SignalTimeoutDto, @CurrentUser('sub') actorId: string) {
    const ms =
      dto.ms != null
        ? dto.ms
        : dto.seconds != null
          ? Number(dto.seconds) * 1000
          : undefined;
    if (ms == null || !Number.isFinite(ms)) {
      throw new BadRequestException('请提?ms ?seconds');
    }
    const res = await this.follower.setSignalTimeoutMs(ms);
    await this.audit.log({
      actorId,
      action: 'SIGNAL_TIMEOUT_UPDATE',
      detail: res,
    });
    return res;
  }

  /** 设置轮询间隔毫秒 (默认 500) */
  @Post('follower/poll-ms')
  async setPollMs(@Body() dto: PollMsDto, @CurrentUser('sub') actorId: string) {
    const res = await this.follower.setPollMs(dto.ms);
    await this.audit.log({
      actorId,
      action: 'FOLLOWER_POLL_MS_UPDATE',
      detail: res,
    });
    return res;
  }

  /** 设置挂单有效秒数 (到期未成交自动撤) */
  @Post('follower/order-expire')
  async setOrderExpire(@Body() dto: OrderExpireDto, @CurrentUser('sub') actorId: string) {
    const res = await this.follower.setOrderExpireSec(dto.seconds);
    await this.audit.log({
      actorId,
      action: 'ORDER_EXPIRE_UPDATE',
      detail: res,
    });
    return res;
  }

  /** 限价过期撤单未成交后是否市价追入 */
  @Post('follower/chase-on-expire')
  async setChaseOnExpire(@Body() dto: ChaseOnExpireDto, @CurrentUser('sub') actorId: string) {
    const res = await this.follower.setChaseOnExpire(!!dto.enabled);
    await this.audit.log({
      actorId,
      action: 'CHASE_ON_EXPIRE_UPDATE',
      detail: res,
    });
    return res;
  }

  /** 关闭跟单：勾选后自动跟单不再开任何新单 */
  @Post('follower/follow-halted')
  async setFollowHalted(@Body() dto: FollowHaltedDto, @CurrentUser('sub') actorId: string) {
    const res = await this.follower.setFollowHalted(!!dto.halted);
    await this.audit.log({
      actorId,
      action: 'FOLLOW_HALTED_UPDATE',
      detail: res,
    });
    return res;
  }

  /** 设置开仓最低点?(低于则禁止开? 平仓不限) */
  @Post('follower/open-min-point')
  async setOpenMinPoint(@Body() dto: OpenMinPointDto, @CurrentUser('sub') actorId: string) {
    const res = await this.trade.setOpenMinPointBalance(dto.amount);
    await this.audit.log({
      actorId,
      action: 'OPEN_MIN_POINT_UPDATE',
      detail: res,
    });
    return res;
  }

  /** 手动跑一轮过期撤?*/
  @Post('follower/cancel-expired')
  cancelExpired() {
    return this.follower.cancelExpiredOrders();
  }

  /**
   * 单笔/勾选立即撤单（PLACED / CANCEL_FAILED?   */
  @Post('follower/cancel-orders')
  async cancelOrders(@Body() dto: AdminCancelOrdersDto, @CurrentUser('sub') actorId: string) {
    const res = await this.follower.adminCancelByIds(dto.ids || []);
    await this.audit.log({
      actorId,
      action: 'ADMIN_CANCEL_ORDERS',
      detail: { ids: dto.ids, ...res },
    });
    return res;
  }

  /**
   * 运营手动撤单测试：选择交易所 + 输入交易所订单??mapi/CancelOrder?   * 用户 Key / 币对优先从跟单流水反查?   */
  @Post('follower/cancel-by-order-id')
  async cancelByOrderId(
    @Body() dto: AdminCancelByOrderIdDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.trade.adminCancelByOrderId(dto);
    await this.audit.log({
      actorId,
      action: 'ADMIN_CANCEL_BY_ORDER_ID',
      targetType: 'User',
      targetId: res.userId,
      detail: {
        exchange: dto.exchange,
        orderId: dto.orderId,
        ok: res.ok,
        filled: res.filled,
        coinName: res.coinName,
      },
    });
    return res;
  }

  /**
   * 运营：拉取用户交易所当前挂单（币?U 本位），用于复制订单号做撤单测试?   * 中间件无挂单列表，直连币?openOrders?   */
  @Get('exchange-open-orders')
  async exchangeOpenOrders(
    @Query('userId') userId: string,
    @Query('exchange') exchange: string,
    @CurrentUser('sub') actorId: string,
  ) {
    if (!userId?.trim()) throw new BadRequestException('请选择用户');
    const ex = (exchange || 'BINANCE').toUpperCase() as Exchange;
    if (!Object.values(Exchange).includes(ex)) {
      throw new BadRequestException('无效交易所');
    }
    const res = await this.trade.adminFetchExchangeOpenOrders({
      userId: userId.trim(),
      exchange: ex,
    });
    await this.audit.log({
      actorId,
      action: 'FETCH_EXCHANGE_OPEN_ORDERS',
      targetType: 'User',
      targetId: userId.trim(),
      detail: { exchange: ex, total: res.total },
    });
    return res;
  }

  /**
   * 运营对账：直连币安 U 本位 userTrades + positionRisk（用该用户已存 Key，不回传密钥）
   * query: userId / exchange=BINANCE / symbol=TUTUSDT / lookbackDays=21
   */
  @Get('exchange-user-trades')
  async exchangeUserTrades(
    @Query('userId') userId: string,
    @Query('exchange') exchange: string,
    @Query('symbol') symbol: string,
    @Query('lookbackDays') lookbackDays: string,
    @CurrentUser('sub') actorId: string,
  ) {
    if (!userId?.trim()) throw new BadRequestException('请选择用户');
    const ex = (exchange || 'BINANCE').toUpperCase() as Exchange;
    if (!Object.values(Exchange).includes(ex)) {
      throw new BadRequestException('无效交易所');
    }
    const res = await this.trade.adminFetchExchangeUserTrades({
      userId: userId.trim(),
      exchange: ex,
      symbol: symbol || '',
      lookbackDays: lookbackDays ? Number(lookbackDays) : undefined,
    });
    await this.audit.log({
      actorId,
      action: 'FETCH_EXCHANGE_USER_TRADES',
      targetType: 'User',
      targetId: userId.trim(),
      detail: {
        exchange: ex,
        symbol: res.symbol,
        trades: res.total,
        positions: res.positions.length,
      },
    });
    return res;
  }

  /**
   * 运营：同步用户交易所挂单 ?本地挂单列表（signal_follow_logs PLACED）?   * 用于币安手动挂的远价限价单出现在挂单列表并可撤单?   */
  @Post('follower/sync-exchange-open-orders')
  async syncExchangeOpenOrders(
    @Body() body: { userId?: string; exchange?: string },
    @CurrentUser('sub') actorId: string,
  ) {
    const userId = String(body?.userId || '').trim();
    if (!userId) throw new BadRequestException('请先选择用户');
    const ex = (body?.exchange || 'BINANCE').toUpperCase() as Exchange;
    if (!Object.values(Exchange).includes(ex)) {
      throw new BadRequestException('无效交易所');
    }
    const res = await this.trade.adminSyncExchangeOpenOrders({
      userId,
      exchange: ex,
    });
    await this.audit.log({
      actorId,
      action: 'SYNC_EXCHANGE_OPEN_ORDERS',
      targetType: 'User',
      targetId: userId,
      detail: res,
    });
    return res;
  }

  /**
   * 批量重试 CANCEL_FAILED（运营工具）
   * body.ids 可选；不传则处理全部失败单（默认最?50?   */
  @Post('follower/retry-cancel-failed')
  async retryCancelFailed(
    @Body() dto: RetryCancelFailedDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.follower.retryCancelFailed({
      ids: dto.ids,
      take: dto.take,
    });
    await this.audit.log({
      actorId,
      action: 'RETRY_CANCEL_FAILED',
      detail: res,
    });
    return res;
  }

  /** 手动跑一轮成交检?*/
  @Post('follower/sync-fills')
  syncFills() {
    return this.follower.syncPlacedOrderFills();
  }

  /**
   * 跟单用户列表（管理端?   * query: exchange / q / readyOnly(默认 true，仅返回满足自动跟单条件的行)
   */
  @Get('followers')
  followers(
    @Query('exchange') exchange?: Exchange,
    @Query('q') q?: string,
    @Query('userId') userId?: string,
    @Query('readyOnly') readyOnly?: string,
  ) {
    const ready =
      readyOnly == null || readyOnly === ''
        ? true
        : !['0', 'false', 'no'].includes(String(readyOnly).toLowerCase());
    return this.trade.listAdminFollowers({
      exchange,
      q,
      userId,
      readyOnly: ready,
    });
  }

  /**
   * 持仓对比：中间件账户 Positions vs 本地 OPEN
   * query: accountGid(必填) / match=both|local_only|live_only|all / userId / q / exchange / coinName
   */
  @Get('positions/compare')
  adminPositionsCompare(
    @Query('accountGid') accountGid?: string,
    @Query('match') match?: string,
    @Query('userId') userId?: string,
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('coinName') coinName?: string,
  ) {
    return this.trade.compareAdminPositions({
      accountGid: accountGid || '',
      match,
      userId,
      q,
      exchange,
      coinName,
    });
  }

  /**
   * 点币名按需：未耗尽开仓订单号 + 最近跟单摘要（不随列表轮询）
   */
  @Get('positions/follow-detail')
  adminPositionFollowDetail(
    @Query('userId') userId?: string,
    @Query('exchange') exchange?: string,
    @Query('coinName') coinName?: string,
    @Query('equalCoinName') equalCoinName?: string,
    @Query('positionSide') positionSide?: string,
  ) {
    return this.trade.getOpenFollowDetail({
      userId: userId || '',
      exchange: exchange || '',
      coinName: coinName || '',
      equalCoinName,
      positionSide,
    });
  }

  /**
   * 管理端持仓列表（本地 user_positions?   * query: status=OPEN|CLOSED / abnormal / userId / q / exchange / coinName / period / accountGid / from / to
   * OPEN：abnormal=true 异常持仓；CLOSED：abnormal=true 异常清除 / false 正常平仓 / all 全部
   * OPEN 按开仓时间筛；CLOSED 按平仓时间筛?   */
  @Get('positions')
  adminPositions(
    @Query('userId') userId?: string,
    @Query('q') q?: string,
    @Query('exchange') exchange?: string,
    @Query('coinName') coinName?: string,
    @Query('period') period?: string,
    @Query('accountGid') accountGid?: string,
    @Query('status') status?: string,
    @Query('abnormal') abnormal?: string,
    @Query('closedKind') closedKind?: string,
    @Query('recordId') recordId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.trade.listAdminPositions({
      userId,
      q,
      exchange,
      coinName,
      period,
      accountGid,
      status,
      abnormal,
      closedKind,
      recordId,
      from,
      to,
    });
  }

  /** 运维手动：按跟单流水回填本地持仓。启动不会自动跑。 */
  @Post('positions/backfill')
  backfillPositions() {
    return this.trade.backfillUserPositionsFromLogs('admin');
  }

  /** 设置 QueryPosition 持仓对齐间隔（分钟，最少 2） */
  @Post('follower/query-position-interval')
  async setQueryPositionInterval(
    @Body() dto: QueryPositionIntervalDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.queryPos.setIntervalMin(dto.minutes);
    await this.audit.log({
      actorId,
      action: 'QUERY_POSITION_INTERVAL_UPDATE',
      detail: res,
    });
    return res;
  }

  /**
   * 管理端：把用户丢进 QueryPosition 对齐队列（不在本请求打中间件）。
   * 不传 userId 则入队全部本地 OPEN 合约用户。同一用户冷却 2 分钟。
   */
  @Post('positions/query-position-sync')
  async enqueueQueryPositionSync(
    @Body() dto: QueryPositionSyncDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.queryPos.enqueueTargets({
      reason: 'manual',
      userId: dto?.userId,
      exchange: dto?.exchange,
    });
    await this.audit.log({
      actorId,
      action: 'QUERY_POSITION_SYNC_ENQUEUE',
      targetType: dto?.userId ? 'User' : 'System',
      targetId: dto?.userId || undefined,
      detail: res,
    });
    return res;
  }

  /**
   * 运维：按信号账户 Positions 对账本地 OPEN（独有强平 + 多的平，市价）
   */
  @Post('positions/reconcile')
  async reconcilePositions(@CurrentUser('sub') actorId: string) {
    const res = await this.trade.reconcileAllOpenPositions('admin');
    await this.audit.log({
      actorId,
      action: 'POSITION_RECONCILE',
      targetType: 'System',
      detail: res,
    });
    return res;
  }

  /**
   * 管理端手动市价平仓（PlaceOrder isOpen=false）?   * 日常平仓依赖跟单信号；此接口仅运营兜底?   */
  @Post('positions/close')
  async adminClosePosition(
    @Body() dto: AdminClosePositionDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.trade.adminClosePosition(dto);
    await this.audit.log({
      actorId,
      action: 'ADMIN_CLOSE_POSITION',
      targetType: 'User',
      targetId: dto.userId,
      detail: {
        exchange: dto.exchange,
        coinName: dto.coinName,
        positionSide: dto.positionSide,
        amount: dto.amount,
        accountGid: dto.accountGid,
      },
    });
    return res;
  }

  /**
   * 运维：异常仓删除为死仓（不向交易所下单）。
   * 停定时重试、不计利润；保留失败原因供已平仓列表展示。
   */
  @Post('positions/discard-local')
  async discardLocalPositions(
    @Body() dto: AdminDiscardLocalPositionsDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.trade.adminDiscardLocalPositions(dto.ids || []);
    await this.audit.log({
      actorId,
      action: 'ADMIN_DISCARD_LOCAL_POSITIONS',
      targetType: 'UserPosition',
      detail: { ids: dto.ids, ...res },
    });
    return res;
  }

  /** 跟单模板列表 */
  @Get('follow-templates')
  async listFollowTemplates() {
    const items = await this.prisma.followTemplate.findMany({
      orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
    });
    return {
      items: items.map((t) => ({
        ...t,
        unitAmount: Number(t.unitAmount),
        maxPrincipal: Number(t.maxPrincipal),
        minInvestAmount: Number(t.minInvestAmount),
      })),
      total: items.length,
    };
  }

  /** 创建/更新跟单模板 */
  @Post('follow-templates')
  async upsertFollowTemplate(
    @Body() dto: UpsertFollowTemplateDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const name = dto.name.trim();
    const accountGid = String(dto.accountGid || '').trim();
    if (!name) throw new BadRequestException('请填写模板名');
    if (!accountGid) throw new BadRequestException('请选择交易账户');
    if (!Number.isFinite(dto.unitAmount) || dto.unitAmount < 0) {
      throw new BadRequestException('单笔最小金额无效');
    }
    if (!Number.isFinite(dto.maxPrincipal) || dto.maxPrincipal < 0) {
      throw new BadRequestException('比例基准本金无效');
    }
    const minInvest = Number(dto.minInvestAmount ?? 0);
    if (!Number.isFinite(minInvest) || minInvest < 0) {
      throw new BadRequestException('最少投入总本金无效');
    }
    if (dto.maxPrincipal > 0 && dto.unitAmount > dto.maxPrincipal) {
      throw new BadRequestException('单笔最小金额不能大于比例基准本金');
    }

    // 优先用前端传来的 name；若空则尝试从中间件列表回填
    let accountName = String(dto.accountName || '').trim() || null;
    if (!accountName) {
      try {
        const { items } = await this.trade.multiAccountList();
        const hit = (items || []).find(
          (a: any) => String(a.value ?? a.gid ?? '').trim() === accountGid,
        );
        if (hit) accountName = String(hit.name || '').trim() || null;
      } catch {
        /* 列表失败不阻断保存?*/
      }
    }

    const data = {
      name,
      exchange: dto.exchange,
      accountGid,
      accountName,
      unitAmount: dto.unitAmount,
      maxPrincipal: dto.maxPrincipal,
      minInvestAmount: minInvest,
      active: dto.active ?? true,
      remark: dto.remark?.trim() || null,
    };

    let row;
    if (dto.id) {
      const old = await this.prisma.followTemplate.findUnique({ where: { id: dto.id } });
      if (!old) throw new NotFoundException('模板不存在');
      row = await this.prisma.followTemplate.update({ where: { id: dto.id }, data });
    } else {
      row = await this.prisma.followTemplate.create({ data });
    }

    await this.audit.log({
      actorId,
      action: dto.id ? 'FOLLOW_TEMPLATE_UPDATE' : 'FOLLOW_TEMPLATE_CREATE',
      targetType: 'FollowTemplate',
      targetId: row.id,
      detail: {
        name: row.name,
        exchange: row.exchange,
        accountGid: row.accountGid,
        accountName: row.accountName,
        unitAmount: Number(row.unitAmount),
        maxPrincipal: Number(row.maxPrincipal),
        minInvestAmount: Number(row.minInvestAmount),
        active: row.active,
      },
    });

    return {
      ...row,
      unitAmount: Number(row.unitAmount),
      maxPrincipal: Number(row.maxPrincipal),
      minInvestAmount: Number(row.minInvestAmount),
    };
  }

  /** 删除跟单模板 */
  @Delete('follow-templates/:id')
  async deleteFollowTemplate(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const old = await this.prisma.followTemplate.findUnique({ where: { id } });
    if (!old) throw new NotFoundException('模板不存在');
    await this.prisma.followTemplate.delete({ where: { id } });
    await this.audit.log({
      actorId,
      action: 'FOLLOW_TEMPLATE_DELETE',
      targetType: 'FollowTemplate',
      targetId: id,
      detail: { name: old.name, exchange: old.exchange },
    });
    return { ok: true };
  }

  /**
   * 跟单委托日志（管理员查询）
   * status: PENDING|PLACED|FILLED|CANCELLED|CANCEL_FAILED|FAILED
   * abnormalKind: NONE|BUSINESS|SYSTEM|ANY
   * fillKind: NONE|PARTIAL|FULL
   */
  @Get('follow-logs')
  async followLogs(
    @Query('skip') skip = '0',
    @Query('take') take = '50',
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('cancelReason') cancelReason?: string,
    @Query('exchange') exchange?: string,
    @Query('symbol') symbol?: string,
    @Query('coinName') coinName?: string,
    @Query('period') period?: string,
    @Query('accountGid') accountGid?: string,
    @Query('q') q?: string,
    @Query('recordId') recordId?: string,
    @Query('orderId') orderId?: string,
    @Query('abnormalKind') abnormalKind?: string,
    @Query('fillKind') fillKind?: string,
  ) {
    const where: any = {};
    const rid = String(recordId || '').trim();
    const oid = String(orderId || '').trim();
    if (rid) where.id = rid;
    if (oid) where.orderId = oid;
    if (status?.trim()) {
      const parts = status
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (parts.length > 1) where.status = { in: parts };
      else if (parts.length === 1) where.status = parts[0];
    }
    if (userId) where.userId = userId;
    if (cancelReason) where.cancelReason = cancelReason;
    if (exchange) where.exchange = exchange;
    if (symbol?.trim()) where.symbol = { contains: symbol.trim() };
    if (coinName?.trim()) where.coinName = { contains: coinName.trim() };
    if (accountGid?.trim()) where.accountGid = accountGid.trim();
    const ab = String(abnormalKind || '').trim().toUpperCase();
    if (ab === 'BUSINESS' || ab === 'SYSTEM') where.abnormalKind = ab;
    else if (ab === 'ANY') where.abnormalKind = { in: ['BUSINESS', 'SYSTEM'] };
    else if (ab === 'NONE') where.abnormalKind = 'NONE';
    const fk = String(fillKind || '').trim().toUpperCase();
    if (fk === 'NONE' || fk === 'PARTIAL' || fk === 'FULL') where.fillKind = fk;
    // period: spot | perpetual | delivery
    const p = String(period || '').toLowerCase();
    if (p === 'spot') {
      where.accountType = 'spot';
    } else if (p === 'perpetual') {
      where.equalCoinName = 'PC';
    } else if (p === 'delivery') {
      where.AND = [
        ...(where.AND || []),
        { accountType: { in: ['future', 'futures', 'swap', 'perp'] } },
        { NOT: { equalCoinName: 'PC' } },
      ];
    }
    if (q?.trim()) {
      const kw = q.trim();
      const userOr: any[] = [
        { email: { contains: kw } },
        { nickname: { contains: kw } },
        { id: kw },
      ];
      if (/^\d+$/.test(kw)) {
        userOr.push({ userNo: Number(kw) });
      }
      where.user = { OR: userOr };
    }
    const takeN = Math.min(200, Number(take) || 50);
    const skipN = Number(skip) || 0;
    const [items, total] = await Promise.all([
      this.prisma.signalFollowLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: skipN,
        take: takeN,
        include: { user: { select: { email: true, nickname: true, userNo: true } } },
      }),
      this.prisma.signalFollowLog.count({ where }),
    ]);
    return { items, total };
  }

  /** 撤单相关汇总?(便于管理端查看?/ 失败提醒) */
  @Get('follow-logs/stats')
  async followLogStats() {
    const groups = await this.prisma.signalFollowLog.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const g of groups) byStatus[g.status] = g._count._all;
    const [expiredCancelled, cancelFailed, recentCancelFails, systemAbnormal, businessAbnormal] =
      await Promise.all([
        this.prisma.signalFollowLog.count({
          where: { status: 'CANCELLED', cancelReason: 'EXPIRED' },
        }),
        this.prisma.signalFollowLog.count({ where: { status: 'CANCEL_FAILED' } }),
        this.prisma.signalFollowLog.findMany({
          where: { status: 'CANCEL_FAILED' },
          orderBy: { updatedAt: 'desc' },
          take: 10,
          include: { user: { select: { email: true, nickname: true } } },
        }),
        this.prisma.signalFollowLog.count({ where: { abnormalKind: 'SYSTEM' } }),
        this.prisma.signalFollowLog.count({ where: { abnormalKind: 'BUSINESS' } }),
      ]);
    return {
      byStatus,
      expiredCancelled,
      cancelFailed,
      recentCancelFails,
      systemAbnormal,
      businessAbnormal,
    };
  }

  /**
   * 清理挂单/跟单流水（全?/ 按时间范?/ 按勾?id）?   * ?createdAt ?id；分批删除?   */
  @Post('follow-logs/purge')
  async purgeFollowLogs(@Body() body: PurgeFollowLogsBody) {
    if (body.mode === 'ids') {
      const ids = [
        ...new Set(
          (body.ids || [])
            .map((x) => String(x || '').trim())
            .filter(Boolean),
        ),
      ];
      if (ids.length === 0) {
        throw new BadRequestException('请选择要删除的日志');
      }
      const batch = 2000;
      let deleted = 0;
      for (let i = 0; i < ids.length; i += batch) {
        const chunk = ids.slice(i, i + batch);
        const r = await this.prisma.signalFollowLog.deleteMany({
          where: { id: { in: chunk } },
        });
        deleted += r.count;
      }
      return { ok: true as const, deleted };
    }

    const where: { createdAt?: { gte?: Date; lte?: Date } } = {};
    if (body.mode === 'range') {
      if (!body.from?.trim() && !body.to?.trim()) {
        throw new BadRequestException('请填写开始或结束时间');
      }
      const createdAt: { gte?: Date; lte?: Date } = {};
      if (body.from?.trim()) {
        const from = new Date(body.from.trim());
        if (Number.isNaN(from.getTime())) throw new BadRequestException('开始时间无效');
        createdAt.gte = from;
      }
      if (body.to?.trim()) {
        const to = new Date(body.to.trim());
        if (Number.isNaN(to.getTime())) throw new BadRequestException('结束时间无效');
        createdAt.lte = to;
      }
      if (createdAt.gte && createdAt.lte && createdAt.gte > createdAt.lte) {
        throw new BadRequestException('开始时间不能晚于结束时间');
      }
      where.createdAt = createdAt;
    }

    const batch = 2000;
    let deleted = 0;
    for (;;) {
      const ids = await this.prisma.signalFollowLog.findMany({
        where,
        select: { id: true },
        take: batch,
      });
      if (ids.length === 0) break;
      const r = await this.prisma.signalFollowLog.deleteMany({
        where: { id: { in: ids.map((x) => x.id) } },
      });
      deleted += r.count;
      if (ids.length < batch) break;
    }
    return { ok: true as const, deleted };
  }

  /** 手动录入平仓利润 (联调/补录), 入库后自动结算佣?*/
  @Post('profit/manual')
  async manualProfit(@Body() dto: ManualProfitDto, @CurrentUser('sub') actorId: string) {
    const res = await this.trade.recordProfitManual(dto);
    await this.audit.log({
      actorId,
      action: 'PROFIT_MANUAL_RECORD',
      targetType: 'ProfitRecord',
      targetId: res.id,
      detail: { userId: dto.userId, profit: dto.profit, symbol: dto.symbol },
    });
    return res;
  }

  /**
   * 已实现盈亏公式试?(不入??   * ? (closeAvg-openAvg)×qty×multiplier + openFee + closeFee
   * ? (openAvg-closeAvg)×qty×multiplier + openFee + closeFee
   * 手续费按文档「负数为支付」直接加减?   */
  @Post('profit/preview')
  previewPnl(@Body() dto: PreviewPnlDto) {
    return this.trade.calcRealizedPnl({
      positionSide: dto.positionSide,
      openAvg: dto.openAvg,
      closeAvg: dto.closeAvg,
      qty: dto.qty,
      openFeeShare: dto.openFee ?? 0,
      closeFeeShare: dto.closeFee ?? 0,
      multiplier: dto.multiplier ?? 1,
    });
  }
}
