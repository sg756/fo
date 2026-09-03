import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  forwardRef,
} from '@nestjs/common';
import { UserRole } from '../../common/auth-role';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/decorators';
import { IpPoolService } from './ippool.service';
import { TradeService } from '../trade/trade.service';

class CreateProxyDto {
  @IsString() name: string;
  @IsString() host: string;
  @IsInt() port: number;
  @IsString() egressIp: string;
  @IsOptional() @IsString() proxyType?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() username?: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsInt() weight?: number;
}

class UpdateProxyDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() host?: string;
  @IsOptional() @IsInt() port?: number;
  @IsOptional() @IsString() egressIp?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsInt() weight?: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() healthy?: boolean;
}

class AssignDto {
  @IsString() userId: string;
  @IsString() proxyId: string;
  @IsOptional() @IsString() reason?: string;
}

class EvacuateDto {
  @IsOptional() @IsString() toProxyId?: string;
}

class PoolConfigDto {
  @IsOptional() @IsInt() usersPerProxy?: number;
  @IsOptional() @IsInt() idleNoFillDays?: number;
  @IsOptional() @IsInt() idleFollowOffDays?: number;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/ip-pool')
export class IpPoolController {
  constructor(
    private svc: IpPoolService,
    @Inject(forwardRef(() => TradeService)) private trade: TradeService,
  ) {}

  /** 从中间件 PublicHttpProxyList 同步并返回代理列表；中间件失败时回退本地缓存 */
  @Get()
  async list(@Query('force') force?: string) {
    try {
      const { items } = await this.trade.publicHttpProxyList({
        force: force === '1' || force === 'true',
      });
      const synced = await this.svc.syncFromMiddleware(items);
      return {
        items: synced,
        syncError: null as string | null,
        syncErrorBody: null as any,
        syncErrorStatus: null as number | null,
      };
    } catch (e: any) {
      const detail = this.extractMiddlewareError(e);
      const local = await this.svc.list();
      return {
        items: local,
        syncError: detail.message,
        syncErrorBody: detail.responseBody,
        syncErrorStatus: detail.statusCode,
      };
    }
  }

  @Get('capacity')
  async capacity() {
    let syncError: string | null = null;
    let syncErrorBody: any = null;
    let syncErrorStatus: number | null = null;
    try {
      const { items } = await this.trade.publicHttpProxyList();
      await this.svc.syncFromMiddleware(items);
    } catch (e: any) {
      const detail = this.extractMiddlewareError(e);
      syncError = detail.message;
      syncErrorBody = detail.responseBody;
      syncErrorStatus = detail.statusCode;
    }
    const cap = await this.svc.getCapacity();
    return { ...cap, syncError, syncErrorBody, syncErrorStatus };
  }

  private extractMiddlewareError(e: any): {
    message: string;
    responseBody: any;
    statusCode: number | null;
  } {
    const res = typeof e?.getResponse === 'function' ? e.getResponse() : null;
    if (res && typeof res === 'object') {
      return {
        message: String(res.message || e?.message || '中间件同步失败'),
        responseBody: res.responseBody ?? res,
        statusCode: res.statusCode ?? e?.getStatus?.() ?? null,
      };
    }
    return {
      message: e?.message || '中间件同步失败，已显示本地缓存',
      responseBody: e?.responseBody ?? null,
      statusCode: e?.statusCode ?? null,
    };
  }

  @Get('config')
  config() {
    return this.svc.getPoolConfig();
  }

  @Post('config')
  setConfig(@Body() dto: PoolConfigDto) {
    return this.svc.setPoolConfig(dto);
  }

  @Post('reclaim-idle')
  reclaimIdle() {
    return this.svc.reclaimIdle();
  }

  /** 失效代理：迁绑用户到健康代理后删除行 */
  @Post('cleanup-inactive')
  cleanupInactive() {
    return this.svc.cleanupInactiveProxies();
  }

  @Get('reclaims')
  reclaims(
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('userNo') userNo?: string,
    @Query('account') account?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.svc.listReclaims({
      status,
      userId,
      userNo,
      account,
      from,
      to,
      skip: Number(skip),
      take: Number(take),
    });
  }

  @Get('reflow-logs')
  reflowLogs(
    @Query('result') result?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.svc.listReflowLogs({
      result,
      skip: Number(skip),
      take: Number(take),
    });
  }

  @Post()
  create(@Body() dto: CreateProxyDto) {
    return this.svc.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateProxyDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.svc.remove(id);
  }

  @Get('preview')
  preview(@Query('userId') userId: string) {
    return this.svc.preview(userId);
  }

  @Post('assign')
  assign(@Body() dto: AssignDto) {
    return this.svc.assign(dto.userId, dto.proxyId, dto.reason);
  }

  @Delete('assign/:userId')
  clear(@Param('userId') userId: string) {
    return this.svc.clearAssignment(userId);
  }

  @Post(':id/evacuate')
  evacuate(@Param('id') id: string, @Body() dto: EvacuateDto) {
    return this.svc.evacuate(id, dto.toProxyId);
  }
}

@UseGuards(JwtAuthGuard)
@Controller('ip-whitelist')
export class IpWhitelistController {
  constructor(private svc: IpPoolService) {}

  @Get()
  egress() {
    return this.svc.egressIps();
  }
}
