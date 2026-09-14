import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';

async function bootstrap() {
  const logger = new Logger('VideoWorker');
  await NestFactory.createApplicationContext(WorkerModule);
  logger.log('Video worker started, consuming video-processing queue');
}
void bootstrap();
