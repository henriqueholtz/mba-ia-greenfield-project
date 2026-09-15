import { DataSource, QueryFailedError, Repository } from 'typeorm';
import type { Queue } from 'bullmq';
import { VideosService } from './videos.service';
import { Video } from './entities/video.entity';
import { StorageService } from '../storage/storage.service';
import type { Channel } from '../channels/entities/channel.entity';

type MockRepository = jest.Mocked<
  Pick<Repository<Video>, 'findOne' | 'create' | 'save'>
>;

function makeRepository(
  overrides: Partial<MockRepository> = {},
): MockRepository {
  return {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    ...overrides,
  } as unknown as MockRepository;
}

function makeDataSource(repository: MockRepository): DataSource {
  return {
    getRepository: jest.fn().mockReturnValue(repository),
  } as unknown as DataSource;
}

type MockStorageService = jest.Mocked<
  Pick<StorageService, 'createMultipartUpload' | 'completeMultipartUpload'>
>;

function makeStorageService(
  overrides: Partial<MockStorageService> = {},
): MockStorageService {
  return {
    createMultipartUpload: jest.fn().mockResolvedValue({
      uploadId: 'upload-1',
      partUrls: [{ partNumber: 1, url: 'https://example.com/part1' }],
    }),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MockStorageService;
}

type MockQueue = jest.Mocked<Pick<Queue, 'add'>>;

function makeQueue(overrides: Partial<MockQueue> = {}): MockQueue {
  return {
    add: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as MockQueue;
}

function makeVideo(overrides: Partial<Video> = {}): Video {
  const v = new Video();
  v.id = 'video-id';
  v.channel_id = 'channel-id';
  v.slug = 'abc12345';
  v.title = 'Title';
  v.status = 'draft';
  v.storage_key = 'videos/abc12345/original';
  v.mime_type = 'video/mp4';
  v.file_size_bytes = '1000';
  Object.assign(v, overrides);
  return v;
}

function makeUniqueError(): QueryFailedError {
  const driverError = Object.assign(new Error('duplicate key value'), {
    code: '23505',
    detail: 'Key (slug)=(abc12345) already exists.',
  });
  return new QueryFailedError('INSERT', [], driverError);
}

function makeService(
  repository: MockRepository,
  storageService: MockStorageService,
  queue: MockQueue,
): VideosService {
  return new VideosService(
    makeDataSource(repository),
    storageService as unknown as StorageService,
    queue as unknown as Queue,
  );
}

describe('VideosService', () => {
  describe('createDraft', () => {
    it('persists a draft video and initiates a multipart upload when no slug collision', async () => {
      const video = makeVideo();
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(video),
        save: jest.fn().mockResolvedValue(video),
      });
      const storageService = makeStorageService();
      const service = makeService(repository, storageService, makeQueue());

      const result = await service.createDraft(
        'channel-id',
        'Title',
        1000,
        'video/mp4',
      );

      expect(repository.save).toHaveBeenCalledTimes(2);
      expect(storageService.createMultipartUpload).toHaveBeenCalledTimes(1);
      expect(result.uploadId).toBe('upload-1');
      expect(result.partUrls).toEqual([
        { partNumber: 1, url: 'https://example.com/part1' },
      ]);
    });

    it('retries with a new slug when pre-check finds an existing slug', async () => {
      const colliding = makeVideo({ slug: 'colliding' });
      const resolved = makeVideo({ slug: 'resolved1' });
      const repository = makeRepository({
        findOne: jest
          .fn()
          .mockResolvedValueOnce(colliding)
          .mockResolvedValueOnce(null),
        create: jest.fn().mockReturnValue(resolved),
        save: jest.fn().mockResolvedValue(resolved),
      });
      const storageService = makeStorageService();
      const service = makeService(repository, storageService, makeQueue());

      await service.createDraft('channel-id', 'Title', 1000, 'video/mp4');

      expect(repository.findOne).toHaveBeenCalledTimes(2);
      expect(repository.save).toHaveBeenCalledTimes(2);
    });

    it('retries with a new slug on concurrent unique constraint violation', async () => {
      const resolved = makeVideo({ slug: 'resolved2' });
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(resolved),
        save: jest
          .fn()
          .mockRejectedValueOnce(makeUniqueError())
          .mockResolvedValueOnce(resolved)
          .mockResolvedValueOnce(resolved),
      });
      const storageService = makeStorageService();
      const service = makeService(repository, storageService, makeQueue());

      const result = await service.createDraft(
        'channel-id',
        'Title',
        1000,
        'video/mp4',
      );

      expect(repository.save).toHaveBeenCalledTimes(3);
      expect(result.video).toBe(resolved);
    });

    it('throws after exhausting max retries', async () => {
      const existing = makeVideo();
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(existing),
      });
      const storageService = makeStorageService();
      const service = makeService(repository, storageService, makeQueue());

      await expect(
        service.createDraft('channel-id', 'Title', 1000, 'video/mp4'),
      ).rejects.toThrow(
        'Slug conflict could not be resolved after max retries',
      );
    });

    it('re-throws non-unique-constraint errors immediately', async () => {
      const unexpectedError = new Error('Connection lost');
      const video = makeVideo();
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(video),
        save: jest.fn().mockRejectedValue(unexpectedError),
      });
      const storageService = makeStorageService();
      const service = makeService(repository, storageService, makeQueue());

      await expect(
        service.createDraft('channel-id', 'Title', 1000, 'video/mp4'),
      ).rejects.toThrow('Connection lost');
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('plans multiple parts for large files', async () => {
      const video = makeVideo();
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockReturnValue(video),
        save: jest.fn().mockResolvedValue(video),
      });
      const storageService = makeStorageService();
      const service = makeService(repository, storageService, makeQueue());

      const tenGb = 10 * 1024 * 1024 * 1024;
      await service.createDraft('channel-id', 'Title', tenGb, 'video/mp4');

      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        expect.any(String),
        'video/mp4',
        expect.any(Number),
      );
      const partCountArg =
        storageService.createMultipartUpload.mock.calls[0][2];
      expect(partCountArg).toBeGreaterThan(1);
    });
  });

  describe('completeUpload', () => {
    function makeDraftVideoWithChannel(userId: string): Video {
      const video = makeVideo({ upload_id: 'upload-1' });
      video.channel = { id: 'channel-id', user_id: userId } as Channel;
      return video;
    }

    it('completes the multipart upload, transitions to processing and enqueues the job', async () => {
      const video = makeDraftVideoWithChannel('user-1');
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(video),
        save: jest.fn().mockImplementation((v) => Promise.resolve(v)),
      });
      const storageService = makeStorageService();
      const queue = makeQueue();
      const service = makeService(repository, storageService, queue);

      const result = await service.completeUpload(
        'video-id',
        [{ partNumber: 1, etag: 'etag-1' }],
        'user-1',
      );

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        video.storage_key,
        'upload-1',
        [{ partNumber: 1, etag: 'etag-1' }],
      );
      expect(result.status).toBe('processing');
      expect(queue.add).toHaveBeenCalledWith('video.process', {
        videoId: video.id,
        storageKey: video.storage_key,
      });
    });

    it('throws VideoNotFoundException when the video does not exist', async () => {
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(null),
      });
      const service = makeService(
        repository,
        makeStorageService(),
        makeQueue(),
      );

      await expect(
        service.completeUpload('missing-id', [], 'user-1'),
      ).rejects.toThrow('Video not found');
    });

    it('throws VideoForbiddenException when the caller does not own the channel', async () => {
      const video = makeDraftVideoWithChannel('owner-id');
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const service = makeService(
        repository,
        makeStorageService(),
        makeQueue(),
      );

      await expect(
        service.completeUpload('video-id', [], 'someone-else'),
      ).rejects.toThrow('You do not have access to this video');
    });

    it('throws VideoAlreadyProcessedException when status is not draft', async () => {
      const video = makeDraftVideoWithChannel('user-1');
      video.status = 'processing';
      const repository = makeRepository({
        findOne: jest.fn().mockResolvedValue(video),
      });
      const queue = makeQueue();
      const service = makeService(repository, makeStorageService(), queue);

      await expect(
        service.completeUpload('video-id', [], 'user-1'),
      ).rejects.toThrow('Video upload has already been completed');
      expect(queue.add).not.toHaveBeenCalled();
    });
  });
});
