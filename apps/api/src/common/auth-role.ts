/** JWT / 守卫用角色（与 users/admins 分表后，不再存在于 Prisma User 字段） */
export enum UserRole {
  ADMIN = 'ADMIN',
  USER = 'USER',
}
