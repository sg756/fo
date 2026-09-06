import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ALL_ADMIN_MENUS, normalizeMenus } from '../../common/admin-menus';

@Injectable()
export class AdminRoleService implements OnModuleInit {
  constructor(private prisma: PrismaService) {}

  async onModuleInit() {
    await this.ensureDefaults();
  }

  async ensureDefaults() {
    const system = await this.prisma.adminRole.upsert({
      where: { code: 'system' },
      create: {
        code: 'system',
        name: '系统管理员',
        menus: ALL_ADMIN_MENUS,
        isSystem: true,
        description: '全部菜单；可配置角色与管理员',
      },
      update: { menus: ALL_ADMIN_MENUS, name: '系统管理员' },
    });

    await this.prisma.adminRole.upsert({
      where: { code: 'ops' },
      create: {
        code: 'ops',
        name: '运营',
        menus: [
          'dashboard',
          'user_list',
          'users',
          'distribution',
          'trade_config',
          'trade_templates',
          'trade_symbols',
          'trade_signals',
          'trade_logs',
          'trade_order_logs',
          'trade_positions',
          'trade_followers',
          'keys_audit',
        ],
        isSystem: true,
        description: '用户与跟单运营',
      },
      update: {
        menus: [
          'dashboard',
          'user_list',
          'users',
          'distribution',
          'trade_config',
          'trade_templates',
          'trade_symbols',
          'trade_signals',
          'trade_logs',
          'trade_order_logs',
          'trade_positions',
          'trade_followers',
          'keys_audit',
        ],
      },
    });

    await this.prisma.adminRole.upsert({
      where: { code: 'finance' },
      create: {
        code: 'finance',
        name: '财务',
        menus: [
          'dashboard',
          'pointcard',
          'recharges',
          'commission',
          'commission_records',
          'reconcile',
          'withdraws',
          'wallet',
          'collection_addresses',
          'gas_wallets',
          'collection_records',
        ],
        isSystem: true,
        description: '资金与分润',
      },
      update: {
        menus: [
          'dashboard',
          'pointcard',
          'recharges',
          'commission',
          'commission_records',
          'reconcile',
          'withdraws',
          'wallet',
          'collection_addresses',
          'gas_wallets',
          'collection_records',
        ],
      },
    });

    // 未分配岗位的管理员 → 系统管理员
    await this.prisma.admin.updateMany({
      where: { adminRoleId: null },
      data: { adminRoleId: system.id },
    });

    return system;
  }

  async menusForAdmin(adminId: string): Promise<string[]> {
    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      include: { adminRole: true },
    });
    if (!admin) return [];
    if (!admin.adminRole) return [...ALL_ADMIN_MENUS];
    return normalizeMenus(admin.adminRole.menus);
  }
}
