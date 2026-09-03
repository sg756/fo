import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { jwtModuleAsync } from '../../common/jwt-register';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from '../../common/jwt.strategy';

@Module({
  imports: [PassportModule, jwtModuleAsync],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
