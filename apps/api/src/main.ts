import { existsSync } from 'fs';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';

/** 管理端 Vite 产物目录：默认 monorepo 的 apps/admin/dist，可用 ADMIN_DIST 覆盖 */
function resolveAdminDist(): string | null {
  const fromEnv = (process.env.ADMIN_DIST || '').trim();
  const candidates = [
    fromEnv,
    join(__dirname, '..', '..', 'admin', 'dist'),
    join(process.cwd(), '..', 'admin', 'dist'),
    join(process.cwd(), 'admin-dist'),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'index.html'))) return dir;
  }
  return null;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix('api');
  app.enableCors();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // 无 Nginx：同一进程托管管理端静态页（/api 走 Nest，其余走 SPA）
  const adminDist = resolveAdminDist();
  if (adminDist) {
    app.useStaticAssets(adminDist, { index: false });
    const http = app.getHttpAdapter().getInstance();
    http.get(/^(?!\/api(?:\/|$)).*/, (req: any, res: any, next: any) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile(join(adminDist, 'index.html'), (err: any) => {
        if (err) next(err);
      });
    });
    Logger.log(`管理端静态目录: ${adminDist}`, 'Bootstrap');
  } else {
    Logger.warn(
      '未找到 apps/admin/dist（请先 npm run build 管理端，或设置 ADMIN_DIST）',
      'Bootstrap',
    );
  }

  const port = Number(process.env.PORT) || 3000;
  await app.listen(port, '0.0.0.0');
  Logger.log(`FlowOrder 已启动: http://0.0.0.0:${port}/  (API: /api)`, 'Bootstrap');
}
bootstrap();
