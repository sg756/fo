import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '../../common/auth-role';
import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { CommissionService } from './commission.service';

class RuleDto {
  @IsOptional() @IsString() id?: string;
  @IsOptional() @IsString() name?: string;
  /** 每单从正利润抽取的比例（抽成池） */
  @IsNumber() @Min(0) @Max(1) extractRate: number;
  /** 以下三级相对抽成池 */
  @IsNumber() @Min(0) @Max(1) l1Rate: number;
  @IsNumber() @Min(0) @Max(1) l2Rate: number;
  @IsNumber() @Min(0) @Max(1) platformRate: number;
  @IsOptional() @IsBoolean() active?: boolean;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/commission')
export class CommissionController {
  constructor(private svc: CommissionService) {}

  @Get('rules')
  rules() {
    return this.svc.listRules();
  }

  @Post('rules')
  upsert(@Body() dto: RuleDto, @CurrentUser('sub') actorId: string) {
    return this.svc.upsertRule({ ...dto, updatedById: actorId });
  }

  @Post('rules/:id/activate')
  activate(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    return this.svc.activateRule(id, actorId);
  }

  @Delete('rules/:id')
  remove(@Param('id') id: string) {
    return this.svc.deleteRule(id);
  }

  @Get('records')
  records(
    @Query('earnerId') earnerId?: string,
    @Query('earner') earner?: string,
    @Query('fromUser') fromUser?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.svc.listRecords({
      earnerId,
      earner,
      fromUser,
      from,
      to,
      skip: Number(skip),
      take: Number(take),
    });
  }

  /** 佣金记录来源溯源（利润 → 平仓单 → 配对开仓） */
  @Get('records/:id/source')
  recordSource(@Param('id') id: string) {
    return this.svc.getRecordSource(id);
  }

  /** ???????????? */
  @Get('daily-summary')
  dailySummary(@Query('earnerId') earnerId: string, @Query('days') days = '90') {
    return this.svc.dailySummary({ earnerId, days: Number(days) || 90 });
  }

  @Post('settle')
  settle(@CurrentUser('sub') actorId: string) {
    return this.svc.settle(actorId);
  }

  /**
   * ????: ?? / SHARE_DEDUCT / ??
   * query.date = YYYY-MM-DD, ????
   */
  @Get('reconcile')
  reconcile(@Query('date') date?: string, @Query('user') user?: string) {
    return this.svc.reconcileDay(date, user);
  }

  /** 区间对账摘要（默认近 7 日，最多 62 天）；user = 用户ID/昵称/邮箱 */
  @Get('reconcile/recent')
  reconcileRecent(
    @Query('days') days?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('user') user?: string,
  ) {
    return this.svc.reconcileRecent({
      days: days != null && String(days).trim() !== '' ? Number(days) : undefined,
      from,
      to,
      user,
    });
  }
}
