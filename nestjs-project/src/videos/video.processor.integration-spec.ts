import { join } from 'node:path';
import { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideoProcessorService } from './video-processor.service';
import { VideoProcessor } from './video.processor';
import type { VideoProcessJobData } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const storageConfig = {
  endpoint: process.env.MINIO_ENDPOINT ?? 'http://minio:9000',
  accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'streamtube',
  secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'streamtube123',
  bucket: process.env.MINIO_BUCKET ?? 'streamtube-videos',
};

describe('VideoProcessor (WorkerHost) (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let videoProcessorService: VideoProcessorService;
  let processor: VideoProcessor;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    storageService = new StorageService(storageConfig);
    videoProcessorService = new VideoProcessorService(storageService);
    processor = new VideoProcessor(dataSource, videoProcessorService);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createDraftVideo(storageKey: string): Promise<Video> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `worker_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_worker_${counter}`,
        user_id: user.id,
      }),
    );
    return videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: `worker${counter}`,
        title: 'Worker test video',
        status: 'processing',
        storage_key: storageKey,
        mime_type: 'video/mp4',
      }),
    );
  }

  function makeJob(
    videoId: string,
    storageKey: string,
  ): Job<VideoProcessJobData> {
    return { data: { videoId, storageKey } } as Job<VideoProcessJobData>;
  }

  it('updates the video to ready with extracted metadata on a successful job', async () => {
    const storageKey = `videos/worker-success-${Date.now()}/original`;
    await storageService.uploadFile(
      storageKey,
      join(__dirname, 'fixtures', 'test-video.mp4'),
      'video/mp4',
    );
    const video = await createDraftVideo(storageKey);

    await processor.process(makeJob(video.id, storageKey));

    const updated = await videoRepository.findOneOrFail({
      where: { id: video.id },
    });
    expect(updated.status).toBe('ready');
    expect(updated.duration_seconds).toBeGreaterThanOrEqual(1);
    expect(updated.video_codec).toBe('h264');
    expect(updated.width).toBe(320);
    expect(updated.height).toBe(240);
    expect(updated.thumbnail_key).toBe(`videos/${video.id}/thumbnail.png`);
    expect(updated.failure_reason).toBeNull();
  }, 30000);

  it('updates the video to failed with a failure_reason when the source file is corrupted', async () => {
    const storageKey = `videos/worker-failure-${Date.now()}/original`;
    await storageService.uploadFile(
      storageKey,
      join(__dirname, 'fixtures', 'corrupted-video.mp4'),
      'video/mp4',
    );
    const video = await createDraftVideo(storageKey);

    await processor.process(makeJob(video.id, storageKey));

    const updated = await videoRepository.findOneOrFail({
      where: { id: video.id },
    });
    expect(updated.status).toBe('failed');
    expect(updated.failure_reason).toBeTruthy();
  }, 30000);
});
