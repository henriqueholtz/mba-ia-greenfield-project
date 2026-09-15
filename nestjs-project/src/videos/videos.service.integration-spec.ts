import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import * as slugUtil from './slug.util';
import type { VideoProcessJobData } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

const storageConfig = {
  endpoint: process.env.MINIO_ENDPOINT ?? 'http://minio:9000',
  accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'streamtube',
  secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'streamtube123',
  bucket: process.env.MINIO_BUCKET ?? 'streamtube-videos',
};

const redisConnection = {
  host: process.env.REDIS_HOST ?? 'redis',
  port: Number(process.env.REDIS_PORT ?? 6379),
};

describe('VideosService.createDraft (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;
  let videosService: VideosService;
  let queue: Queue;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);

    const storageService = new StorageService(storageConfig);
    queue = new Queue(VIDEO_PROCESSING_QUEUE, { connection: redisConnection });
    videosService = new VideosService(dataSource, storageService, queue);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_svc_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_svc_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('persists a draft video with a unique slug and a multipart upload id before any bytes arrive', async () => {
    const channel = await createChannel();

    const result = await videosService.createDraft(
      channel.id,
      'My video',
      5 * 1024 * 1024,
      'video/mp4',
    );

    expect(result.video.status).toBe('draft');
    expect(result.video.channel_id).toBe(channel.id);
    expect(result.uploadId).toBeTruthy();
    expect(result.partUrls.length).toBeGreaterThanOrEqual(1);

    const persisted = await videoRepository.findOne({
      where: { id: result.video.id },
    });
    expect(persisted?.slug).toBe(result.video.slug);
    expect(persisted?.upload_id).toBe(result.uploadId);
  });

  it('resolves a slug collision by retrying with a new slug', async () => {
    const channel = await createChannel();

    const first = await videosService.createDraft(
      channel.id,
      'First video',
      1024,
      'video/mp4',
    );

    jest
      .spyOn(slugUtil, 'generateSlug')
      .mockReturnValueOnce(first.video.slug)
      .mockReturnValueOnce('unique99');

    const second = await videosService.createDraft(
      channel.id,
      'Second video',
      1024,
      'video/mp4',
    );

    expect(second.video.slug).not.toBe(first.video.slug);

    const all = await videoRepository.find({
      where: { channel_id: channel.id },
    });
    expect(all).toHaveLength(2);

    jest.restoreAllMocks();
  });
});

describe('VideosService.completeUpload (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videosService: VideosService;
  let queue: Queue;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);

    const storageService = new StorageService(storageConfig);
    queue = new Queue(VIDEO_PROCESSING_QUEUE, { connection: redisConnection });
    videosService = new VideosService(dataSource, storageService, queue);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    await queue.drain(true);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `videos_complete_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_complete_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('enqueues a video.process job with the correct payload in the same call that completes the upload', async () => {
    const channel = await createChannel();
    const draft = await videosService.createDraft(
      channel.id,
      'Queued video',
      1024,
      'video/mp4',
    );

    const partUrl = draft.partUrls[0].url;
    const uploadRes = await fetch(partUrl, {
      method: 'PUT',
      body: Buffer.from('fake video bytes'),
    });
    const etag = uploadRes.headers.get('etag') as string;

    const result = await videosService.completeUpload(
      draft.video.id,
      [{ partNumber: 1, etag }],
      channel.user_id,
    );

    expect(result.status).toBe('processing');

    const waiting = await queue.getJobs(['waiting', 'active', 'completed']);
    const job = waiting.find(
      (j) => (j.data as VideoProcessJobData).videoId === draft.video.id,
    );
    expect(job).toBeDefined();
    expect(job?.name).toBe('video.process');
    expect(job?.data).toEqual({
      videoId: draft.video.id,
      storageKey: draft.video.storage_key,
    });
  });
});
