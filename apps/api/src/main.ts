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

/** H5 静态目录：与后台同包，默认 apps/h5，可用 H5_DIST 覆盖 */
function resolveH5Dist(): string | null {
  const fromEnv = (process.env.H5_DIST || '').trim();
  const candidates = [
    fromEnv,
    join(__dirname, '..', '..', 'h5'),
    join(process.cwd(), '..', 'h5'),
    join(process.cwd(), 'h5'),
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

  // 无 Nginx：同一进程托管管理端和 H5（/api 走 Nest）
  const http = app.getHttpAdapter().getInstance();
  const h5Dist = resolveH5Dist();
  if (h5Dist) {
    app.useStaticAssets(h5Dist, { prefix: '/h5', index: false });
    http.get('/h5', (_req: any, res: any) => res.redirect(301, '/h5/'));
    http.get(/^\/h5\/.*/, (req: any, res: any, next: any) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      res.sendFile(join(h5Dist, 'index.html'), (err: any) => {
        if (err) next(err);
      });
    });
    Logger.log(`H5 静态目录: ${h5Dist}  →  /h5/`, 'Bootstrap');
  } else {
    Logger.warn('未找到 apps/h5（发布包未带 H5 时管理端仍可用）', 'Bootstrap');
  }

  const adminDist = resolveAdminDist();
  if (adminDist) {
    app.useStaticAssets(adminDist, { index: false });
    http.get(/^(?!\/api(?:\/|$)|\/h5(?:\/|$)).*/, (req: any, res: any, next: any) => {
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
  Logger.log(
    `FlowOrder 已启动: http://0.0.0.0:${port}/  (API: /api  H5: /h5/)`,
    'Bootstrap',
  );
}
bootstrap();
