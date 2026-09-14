import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import { StorageService } from '../storage/storage.service';

export interface ExtractedMetadata {
  durationSeconds: number;
  videoCodec: string;
  width: number;
  height: number;
  fileSizeBytes: number;
  mimeType: string;
}

export interface ProcessResult {
  metadata: ExtractedMetadata;
  thumbnailKey: string;
}

const THUMBNAIL_TIMESTAMP = '10%';

function probe(filePath: string): Promise<ffmpeg.FfprobeData> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function generateThumbnail(
  filePath: string,
  outputDir: string,
  filename: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(filePath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .screenshots({
        timestamps: [THUMBNAIL_TIMESTAMP],
        filename,
        folder: outputDir,
      });
  });
}

@Injectable()
export class VideoProcessorService {
  constructor(private readonly storageService: StorageService) {}

  async process(
    videoId: string,
    storageKey: string,
    mimeType: string,
  ): Promise<ProcessResult> {
    const workDir = await mkdtemp(join(tmpdir(), `video-${videoId}-`));
    const originalPath = join(workDir, 'original');
    const thumbnailFilename = 'thumbnail.png';

    try {
      await this.storageService.downloadToFile(storageKey, originalPath);

      const probeData = await probe(originalPath);
      const videoStream = probeData.streams.find(
        (s) => s.codec_type === 'video',
      );
      if (!videoStream) {
        throw new Error('No video stream found in file');
      }

      const metadata: ExtractedMetadata = {
        durationSeconds: Math.round(Number(probeData.format.duration ?? 0)),
        videoCodec: videoStream.codec_name ?? 'unknown',
        width: videoStream.width ?? 0,
        height: videoStream.height ?? 0,
        fileSizeBytes: Number(probeData.format.size ?? 0),
        mimeType,
      };

      await generateThumbnail(originalPath, workDir, thumbnailFilename);

      const thumbnailKey = `videos/${videoId}/thumbnail.png`;
      await this.storageService.uploadFile(
        thumbnailKey,
        join(workDir, thumbnailFilename),
        'image/png',
      );

      return { metadata, thumbnailKey };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
