import { Injectable, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { DataSource } from 'typeorm';
import type { Job } from 'bullmq';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { Video } from './entities/video.entity';
import { VideoProcessorService } from './video-processor.service';

export interface VideoProcessJobData {
  videoId: string;
  storageKey: string;
}

@Injectable()
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly videoProcessorService: VideoProcessorService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const { videoId, storageKey } = job.data;
    const videoRepository = this.dataSource.getRepository(Video);

    const video = await videoRepository.findOne({ where: { id: videoId } });
    if (!video) {
      this.logger.warn(`Video ${videoId} not found, skipping job`);
      return;
    }

    try {
      const { metadata, thumbnailKey } =
        await this.videoProcessorService.process(
          videoId,
          storageKey,
          video.mime_type ?? 'application/octet-stream',
        );

      video.status = 'ready';
      video.duration_seconds = metadata.durationSeconds;
      video.video_codec = metadata.videoCodec;
      video.width = metadata.width;
      video.height = metadata.height;
      video.file_size_bytes = String(metadata.fileSizeBytes);
      video.mime_type = metadata.mimeType;
      video.thumbnail_key = thumbnailKey;
      await videoRepository.save(video);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      video.status = 'failed';
      video.failure_reason = reason;
      await videoRepository.save(video);
      this.logger.error(`Video ${videoId} processing failed: ${reason}`);
    }
  }
}
