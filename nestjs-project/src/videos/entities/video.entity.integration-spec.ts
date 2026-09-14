import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter += 1;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should default status to draft', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: 'abc123',
        title: 'My video',
        storage_key: 'videos/abc123/original.mp4',
      }),
    );

    expect(video.status).toBe('draft');
  });

  it('should enforce unique slug constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: 'dupeslug',
        title: 'First',
        storage_key: 'videos/dupeslug/original.mp4',
      }),
    );

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          slug: 'dupeslug',
          title: 'Second',
          storage_key: 'videos/dupeslug2/original.mp4',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should allow multiple videos per channel', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: 'multia',
        title: 'Video A',
        storage_key: 'videos/multia/original.mp4',
      }),
    );
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: 'multib',
        title: 'Video B',
        storage_key: 'videos/multib/original.mp4',
      }),
    );

    const found = await videoRepository.find({
      where: { channel_id: channel.id },
    });

    expect(found).toHaveLength(2);
  });

  it('should allow nullable processing fields to remain null until processed', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: 'nullflds',
        title: 'Unprocessed video',
        storage_key: 'videos/nullflds/original.mp4',
      }),
    );

    expect(video.thumbnail_key).toBeNull();
    expect(video.duration_seconds).toBeNull();
    expect(video.video_codec).toBeNull();
    expect(video.width).toBeNull();
    expect(video.height).toBeNull();
    expect(video.file_size_bytes).toBeNull();
    expect(video.mime_type).toBeNull();
    expect(video.failure_reason).toBeNull();
    expect(video.upload_id).toBeNull();
  });

  it('should load the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        slug: 'relvideo',
        title: 'Related video',
        storage_key: 'videos/relvideo/original.mp4',
      }),
    );

    const found = await videoRepository.findOne({
      where: { slug: 'relvideo' },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });

  it('should reject an invalid status value', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("channel_id", "slug", "title", "status", "storage_key") VALUES ($1, $2, $3, $4, $5)`,
        [
          channel.id,
          'badstat',
          'Bad status',
          'not-a-status',
          'videos/badstat/original.mp4',
        ],
      ),
    ).rejects.toThrow();
  });
});
