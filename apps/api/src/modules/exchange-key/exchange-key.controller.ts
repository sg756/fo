import { UserRole } from '../../common/auth-role';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Exchange } from '@prisma/client';
import { IsBoolean, IsEnum, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, Roles } from '../../common/decorators';
import { AuditService } from '../../common/audit.service';
import { ExchangeKeyService } from './exchange-key.service';

class UpsertKeyDto {
  @IsEnum(Exchange) exchange: Exchange;
  @IsString() apiKey: string;
  @IsString() apiSecret: string;
  @IsOptional() @IsString() passphrase?: string;
  @IsOptional() @IsString() label?: string;
}

class SetActiveDto {
  @IsBoolean() active: boolean;
}

@UseGuards(JwtAuthGuard)
@Controller('exchange-keys')
export class ExchangeKeyController {
  constructor(private svc: ExchangeKeyService) {}

  @Get()
  list(@CurrentUser('sub') userId: string) {
    return this.svc.listForUser(userId);
  }

  @Post()
  upsert(@CurrentUser('sub') userId: string, @Body() dto: UpsertKeyDto) {
    return this.svc.upsert(userId, dto);
  }

  @Delete(':id')
  remove(@CurrentUser('sub') userId: string, @Param('id') id: string) {
    return this.svc.remove(userId, id);
  }
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/exchange-keys')
export class ExchangeKeyAdminController {
  constructor(
    private svc: ExchangeKeyService,
    private audit: AuditService,
  ) {}

  @Get()
  list(
    @Query('userId') userId?: string,
    @Query('q') q?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.svc.listForAdmin({
      userId,
      q,
      skip: Number(skip),
      take: Number(take),
    });
  }

  @Patch(':id/active')
  async setActive(
    @Param('id') id: string,
    @Body() dto: SetActiveDto,
    @CurrentUser('sub') actorId: string,
  ) {
    const res = await this.svc.setActiveByAdmin(id, dto.active);
    await this.audit.log({
      actorId,
      action: dto.active ? 'EXCHANGE_KEY_ENABLE' : 'EXCHANGE_KEY_DISABLE',
      targetType: 'ExchangeKey',
      targetId: id,
    });
    return res;
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser('sub') actorId: string) {
    const res = await this.svc.removeByAdmin(id);
    await this.audit.log({
      actorId,
      action: 'EXCHANGE_KEY_CLEAR',
      targetType: 'ExchangeKey',
      targetId: id,
    });
    return res;
  }
}
