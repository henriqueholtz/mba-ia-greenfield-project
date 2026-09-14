import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { StorageService } from './storage.service';

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockConfig = {
  endpoint: 'http://minio:9000',
  accessKeyId: 'access',
  secretAccessKey: 'secret',
  bucket: 'streamtube-videos',
};

describe('StorageService', () => {
  let service: StorageService;
  let mockSend: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StorageService(mockConfig);
    mockSend = (service as any).client.send as jest.Mock;
  });

  describe('createMultipartUpload', () => {
    it('creates a multipart upload and returns presigned URLs per part', async () => {
      mockSend.mockResolvedValueOnce({ UploadId: 'upload-123' });
      (getSignedUrl as jest.Mock).mockResolvedValue(
        'https://minio/presigned-part',
      );

      const result = await service.createMultipartUpload(
        'videos/abc/original',
        'video/mp4',
        2,
      );

      expect(mockSend).toHaveBeenCalledWith(
        expect.any(CreateMultipartUploadCommand),
      );
      const commandArg = mockSend.mock.calls[0][0];
      expect(commandArg.input).toMatchObject({
        Bucket: 'streamtube-videos',
        Key: 'videos/abc/original',
        ContentType: 'video/mp4',
      });
      expect(result.uploadId).toBe('upload-123');
      expect(result.partUrls).toEqual([
        { partNumber: 1, url: 'https://minio/presigned-part' },
        { partNumber: 2, url: 'https://minio/presigned-part' },
      ]);
      expect(getSignedUrl).toHaveBeenCalledTimes(2);
      const firstUploadPartCommand = (getSignedUrl as jest.Mock).mock
        .calls[0][1];
      expect(firstUploadPartCommand).toBeInstanceOf(UploadPartCommand);
    });
  });

  describe('completeMultipartUpload', () => {
    it('sends parts sorted by part number with mapped ETags', async () => {
      mockSend.mockResolvedValueOnce({});

      await service.completeMultipartUpload(
        'videos/abc/original',
        'upload-123',
        [
          { partNumber: 2, etag: 'etag-2' },
          { partNumber: 1, etag: 'etag-1' },
        ],
      );

      expect(mockSend).toHaveBeenCalledWith(
        expect.any(CompleteMultipartUploadCommand),
      );
      const commandArg = mockSend.mock.calls[0][0];
      expect(commandArg.input).toMatchObject({
        Bucket: 'streamtube-videos',
        Key: 'videos/abc/original',
        UploadId: 'upload-123',
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: 'etag-1' },
            { PartNumber: 2, ETag: 'etag-2' },
          ],
        },
      });
    });
  });

  describe('getPresignedGetUrl', () => {
    it('returns a presigned GET url for the storage key', async () => {
      (getSignedUrl as jest.Mock).mockResolvedValue(
        'https://minio/presigned-get',
      );

      const url = await service.getPresignedGetUrl('videos/abc/original');

      expect(url).toBe('https://minio/presigned-get');
      const commandArg = (getSignedUrl as jest.Mock).mock.calls[0][1];
      expect(commandArg).toBeInstanceOf(GetObjectCommand);
      expect(commandArg.input).toMatchObject({
        Bucket: 'streamtube-videos',
        Key: 'videos/abc/original',
      });
    });

    it('includes a Content-Disposition override when provided', async () => {
      (getSignedUrl as jest.Mock).mockResolvedValue(
        'https://minio/presigned-download',
      );

      await service.getPresignedGetUrl(
        'videos/abc/original',
        'attachment; filename="video.mp4"',
      );

      const commandArg = (getSignedUrl as jest.Mock).mock.calls[0][1];
      expect(commandArg.input.ResponseContentDisposition).toBe(
        'attachment; filename="video.mp4"',
      );
    });
  });
});
