import { UserRole } from '../../common/auth-role';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { Exchange } from '@prisma/client';
import { JwtAuthGuard, RolesGuard } from '../../common/guards';
import { Roles } from '../../common/decorators';
import { PostLogService } from './postlog.service';

class PurgePostLogsBody {
  /** all=清空全部；range=按时间范围 */
  @IsIn(['all', 'range'])
  mode!: 'all' | 'range';

  /** ISO 或 datetime-local 字符串 */
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
}

class SetPostLogEnabledDto {
  @IsBoolean()
  enabled!: boolean;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/post-logs')
export class PostLogController {
  constructor(private svc: PostLogService) {}

  @Get('config')
  config() {
    return this.svc.getConfig();
  }

  @Post('enabled')
  setEnabled(@Body() dto: SetPostLogEnabledDto) {
    return this.svc.setEnabled(!!dto.enabled);
  }

  @Get()
  list(
    @Query('userId') userId?: string,
    @Query('exchange') exchange?: Exchange,
    @Query('success') success?: string,
    @Query('feature') feature?: string,
    @Query('endpoint') endpoint?: string,
    @Query('q') q?: string,
    @Query('searchBody') searchBody?: string,
    @Query('skip') skip = '0',
    @Query('take') take = '50',
  ) {
    return this.svc.list({
      userId,
      exchange,
      success: success === undefined || success === '' ? undefined : success === 'true',
      feature,
      endpoint,
      q,
      searchBody: searchBody === '1' || searchBody === 'true',
      skip: Number(skip),
      take: Number(take),
    });
  }

  @Get('features')
  features() {
    return this.svc.features();
  }

  @Post('purge')
  purge(@Body() body: PurgePostLogsBody) {
    if (body.mode === 'all') {
      return this.svc.purgeAll('admin');
    }
    if (!body.from?.trim() && !body.to?.trim()) {
      throw new BadRequestException('请填写开始或结束时间');
    }
    return this.svc.purgeByRange({
      from: body.from,
      to: body.to,
      reason: 'admin',
    });
  }

  @Get(':id')
  async detail(@Param('id') id: string) {
    const row = await this.svc.getById(id);
    if (!row) throw new NotFoundException('日志不存在');
    return row;
  }
}
