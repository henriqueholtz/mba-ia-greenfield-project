import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { StorageService } from '../storage/storage.service';
import { VideoProcessorService } from './video-processor.service';

const storageConfig = {
  endpoint: process.env.MINIO_ENDPOINT ?? 'http://minio:9000',
  accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'streamtube',
  secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'streamtube123',
  bucket: process.env.MINIO_BUCKET ?? 'streamtube-videos',
};

describe('VideoProcessorService.process (integration)', () => {
  let storageService: StorageService;
  let videoProcessorService: VideoProcessorService;

  beforeAll(() => {
    storageService = new StorageService(storageConfig);
    videoProcessorService = new VideoProcessorService(storageService);
  });

  it('extracts duration, codec, dimensions and generates a thumbnail from a real video file', async () => {
    const videoId = randomUUID();
    const storageKey = `videos/${videoId}/original`;
    const fixturePath = join(__dirname, 'fixtures', 'test-video.mp4');

    await storageService.uploadFile(storageKey, fixturePath, 'video/mp4');

    const result = await videoProcessorService.process(
      videoId,
      storageKey,
      'video/mp4',
    );

    expect(result.metadata.durationSeconds).toBeGreaterThanOrEqual(1);
    expect(result.metadata.videoCodec).toBe('h264');
    expect(result.metadata.width).toBe(320);
    expect(result.metadata.height).toBe(240);
    expect(result.metadata.fileSizeBytes).toBeGreaterThan(0);
    expect(result.metadata.mimeType).toBe('video/mp4');
    expect(result.thumbnailKey).toBe(`videos/${videoId}/thumbnail.png`);

    const thumbnailUrl = await storageService.getPresignedGetUrl(
      result.thumbnailKey,
    );
    const res = await fetch(thumbnailUrl);
    expect(res.ok).toBe(true);
    const bytes = await res.arrayBuffer();
    expect(bytes.byteLength).toBeGreaterThan(0);
  }, 30000);

  it('rejects a corrupted/non-video file', async () => {
    const videoId = randomUUID();
    const storageKey = `videos/${videoId}/original`;
    const fixturePath = join(__dirname, 'fixtures', 'corrupted-video.mp4');

    await storageService.uploadFile(storageKey, fixturePath, 'video/mp4');

    await expect(
      videoProcessorService.process(videoId, storageKey, 'video/mp4'),
    ).rejects.toThrow();
  }, 30000);
});
