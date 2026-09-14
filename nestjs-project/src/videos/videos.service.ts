import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { DataSource, QueryFailedError } from 'typeorm';
import type { Queue } from 'bullmq';
import {
  VideoAlreadyProcessedException,
  VideoForbiddenException,
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import {
  VIDEO_PROCESSING_QUEUE,
  VIDEO_PROCESS_JOB,
} from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import type { CompletedPart } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { generateSlug } from './slug.util';

const PG_UNIQUE_VIOLATION = '23505';
const SLUG_COLUMN = 'slug';
const MAX_RETRIES = 5;
const PART_SIZE_BYTES = 100 * 1024 * 1024;

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as any;
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}

export interface CreateDraftResult {
  video: Video;
  uploadId: string;
  partUrls: { partNumber: number; url: string }[];
}

@Injectable()
export class VideosService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoProcessingQueue: Queue,
  ) {}

  async createDraft(
    channelId: string,
    title: string,
    fileSizeBytes: number,
    mimeType: string,
  ): Promise<CreateDraftResult> {
    let slug = generateSlug();

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const existing = await this.dataSource
        .getRepository(Video)
        .findOne({ where: { slug } });
      if (existing) {
        slug = generateSlug();
        continue;
      }

      const storageKey = `videos/${slug}/original`;
      const partCount = Math.max(1, Math.ceil(fileSizeBytes / PART_SIZE_BYTES));

      try {
        const video = await this.dataSource.getRepository(Video).save(
          this.dataSource.getRepository(Video).create({
            channel_id: channelId,
            slug,
            title,
            storage_key: storageKey,
            mime_type: mimeType,
            file_size_bytes: String(fileSizeBytes),
          }),
        );

        const { uploadId, partUrls } =
          await this.storageService.createMultipartUpload(
            storageKey,
            mimeType,
            partCount,
          );

        video.upload_id = uploadId;
        await this.dataSource.getRepository(Video).save(video);

        return { video, uploadId, partUrls };
      } catch (err) {
        if (isPgUniqueViolationOnColumn(err, SLUG_COLUMN)) {
          slug = generateSlug();
        } else {
          throw err;
        }
      }
    }

    throw new Error('Slug conflict could not be resolved after max retries');
  }

  async completeUpload(
    videoId: string,
    parts: CompletedPart[],
    userId: string,
  ): Promise<Video> {
    const video = await this.dataSource.getRepository(Video).findOne({
      where: { id: videoId },
      relations: ['channel'],
    });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.channel.user_id !== userId) {
      throw new VideoForbiddenException();
    }

    if (video.status !== 'draft') {
      throw new VideoAlreadyProcessedException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id as string,
      parts,
    );

    video.status = 'processing';
    const saved = await this.dataSource.getRepository(Video).save(video);

    await this.videoProcessingQueue.add(VIDEO_PROCESS_JOB, {
      videoId: saved.id,
      storageKey: saved.storage_key,
    });

    return saved;
  }

  async getStreamUrl(videoId: string): Promise<string> {
    const video = await this.getReadyVideoById(videoId);
    return this.storageService.getPresignedGetUrl(video.storage_key);
  }

  async getDownloadUrl(videoId: string): Promise<string> {
    const video = await this.getReadyVideoById(videoId);
    return this.storageService.getPresignedGetUrl(
      video.storage_key,
      `attachment; filename="${video.slug}.mp4"`,
    );
  }

  async getThumbnailUrl(thumbnailKey: string): Promise<string> {
    return this.storageService.getPresignedGetUrl(thumbnailKey);
  }

  async findBySlug(slug: string): Promise<Video> {
    const video = await this.dataSource
      .getRepository(Video)
      .findOne({ where: { slug } });

    if (!video) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  private async getReadyVideoById(videoId: string): Promise<Video> {
    const video = await this.dataSource
      .getRepository(Video)
      .findOne({ where: { id: videoId } });

    if (!video) {
      throw new VideoNotFoundException();
    }

    if (video.status !== 'ready') {
      throw new VideoNotReadyException();
    }

    return video;
  }
}
