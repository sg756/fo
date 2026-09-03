import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

/** 等 ConfigModule 读完 .env 再取密钥，避免签发用 dev-secret、校验用 JWT_SECRET。 */
export const jwtModuleAsync = JwtModule.registerAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    secret: config.get<string>('JWT_SECRET') || 'dev-secret',
    signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') || '7d' },
  }),
});
