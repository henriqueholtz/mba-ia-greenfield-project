import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface MultipartUploadHandle {
  uploadId: string;
  partUrls: { partNumber: number; url: string }[];
}

const PART_URL_EXPIRATION_SECONDS = 3600;
const GET_URL_EXPIRATION_SECONDS = 3600;

@Injectable()
export class StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = this.config.bucket;
    this.client = new S3Client({
      endpoint: this.config.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    });
  }

  async createMultipartUpload(
    storageKey: string,
    mimeType: string,
    partCount: number,
  ): Promise<MultipartUploadHandle> {
    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ContentType: mimeType,
      }),
    );

    const uploadId = created.UploadId as string;
    const partUrls = await this.getPartUploadUrls(
      storageKey,
      uploadId,
      partCount,
    );

    return { uploadId, partUrls };
  }

  async getPartUploadUrls(
    storageKey: string,
    uploadId: string,
    partCount: number,
  ): Promise<{ partNumber: number; url: string }[]> {
    const partNumbers = Array.from({ length: partCount }, (_, i) => i + 1);

    return Promise.all(
      partNumbers.map(async (partNumber) => ({
        partNumber,
        url: await getSignedUrl(
          this.client,
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: storageKey,
            UploadId: uploadId,
            PartNumber: partNumber,
          }),
          { expiresIn: PART_URL_EXPIRATION_SECONDS },
        ),
      })),
    );
  }

  async completeMultipartUpload(
    storageKey: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: storageKey,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
            })),
        },
      }),
    );
  }

  async getPresignedGetUrl(
    storageKey: string,
    responseContentDisposition?: string,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        ...(responseContentDisposition && {
          ResponseContentDisposition: responseContentDisposition,
        }),
      }),
      { expiresIn: GET_URL_EXPIRATION_SECONDS },
    );
  }

  async downloadToFile(storageKey: string, destPath: string): Promise<void> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
    );

    await pipeline(response.Body as Readable, createWriteStream(destPath));
  }

  async uploadFile(
    storageKey: string,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: createReadStream(filePath),
        ContentType: contentType,
      }),
    );
  }
}
