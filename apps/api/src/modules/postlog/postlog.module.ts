import { Global, Module } from '@nestjs/common';
import { PostLogService } from './postlog.service';
import { PostLogController } from './postlog.controller';

@Global()
@Module({
  controllers: [PostLogController],
  providers: [PostLogService],
  exports: [PostLogService],
})
export class PostLogModule {}
