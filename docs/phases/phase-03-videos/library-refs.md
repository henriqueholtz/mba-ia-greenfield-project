---
libs:
  bullmq:
    version: "^6.3.6"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-15T08:00:00-03:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-15T08:00:00-03:00"
  fluent-ffmpeg:
    version: "^2.1.3"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-09-15T08:00:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1131.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-15T08:00:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1131.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-15T08:00:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-15T08:00:00-03:00"
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this slice. Pulled via Context7. Re-fetch when the underlying TD changes.

## bullmq + @nestjs/bullmq

**Source:** `/taskforcesh/bullmq` and `/nestjs/bull` (Context7) — High reputation. Maps to `upload-processing/TD-01` (Option A: BullMQ + Redis).

### Registering the worker

A worker is a class extending `WorkerHost`, decorated with `@Processor(queueName)`, implementing `process(job)`:

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  async process(job: Job<VideoProcessJobData>): Promise<void> {
    const { videoId, storageKey } = job.data;
    // ...
  }
}
```

### Registering the queue for injection

`BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })` in the module that enqueues jobs; `@InjectQueue(VIDEO_PROCESSING_QUEUE) private readonly queue: Queue` injects the producer side. `queue.add(jobName, payload)` enqueues.

### Job typing

`Job<T>` is generic over the job's `data` payload — always parametrize it (`Job<VideoProcessJobData>`) rather than leaving it as the bare `Job`, so `job.data` is typed instead of `any` at the consumer.

### Worker as a separate process

The worker connects to the same Redis instance as the API's queue producer (`REDIS_HOST`/`REDIS_PORT` env vars, Docker service name `redis`) but runs as its own Node entrypoint (`src/worker.ts`) in its own container (`video-worker` service in `compose.yaml`), per `upload-processing/TD-03`. `@nestjs/bullmq`'s `WorkerHost` closes its underlying BullMQ `Worker` automatically on `onApplicationShutdown`.

---

## fluent-ffmpeg

**Source:** `/fluent-ffmpeg/node-fluent-ffmpeg` (Context7) — Medium reputation, 340 snippets. Maps to `upload-processing/TD-03` (metadata extraction + thumbnail generation).

### Metadata extraction (ffprobe)

```typescript
import ffmpeg from 'fluent-ffmpeg';

ffmpeg.ffprobe(filePath, (err, data) => {
  const videoStream = data.streams.find((s) => s.codec_type === 'video');
  const durationSeconds = Number(data.format.duration);
  const codec = videoStream?.codec_name;
  const width = videoStream?.width;
  const height = videoStream?.height;
});
```

`data.format.duration` and stream fields (`codec_name`, `width`, `height`) are the fields `VideoProcessorService` reads to populate `duration_seconds`, `video_codec`, `width`, `height` on the `Video` entity.

### Thumbnail generation (screenshots)

```typescript
ffmpeg(filePath)
  .on('end', () => {
    /* thumbnail written */
  })
  .on('error', (err) => {
    /* propagate to caller, mark video failed */
  })
  .screenshots({
    timestamps: ['50%'],
    filename: 'thumbnail.png',
    folder: outputDir,
  });
```

`screenshots()` does not work on input streams — the worker downloads/streams the source video to a local temp file first, runs `ffprobe` + `screenshots()` against that local path, then uploads the resulting thumbnail back to object storage.

### ffmpeg-static

`ffmpeg-static` ships a prebuilt `ffmpeg` binary; `fluent-ffmpeg` is pointed at it via `ffmpeg.setFfmpegPath(ffmpegStatic)` so the worker container does not depend on a system-installed FFmpeg (the Dockerfile still installs `ffmpeg`/`ffprobe` as a fallback/consistency measure per `upload-processing/TD-03`).

### Error handling

A corrupted or unreadable source file causes `ffprobe`'s callback to receive a non-null `err` and/or the `screenshots()` command to emit an `'error'` event — both must be caught by the worker and mapped to `Video.status = 'failed'` with `failure_reason` set, never left unhandled (would crash the worker process on an unhandled promise rejection).

---

## @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7) — High reputation. Maps to `upload-processing/TD-02` (presigned multipart upload) and the object-storage usage decisions (MinIO, S3-compatible API).

### Multipart upload lifecycle

```typescript
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const created = await client.send(
  new CreateMultipartUploadCommand({ Bucket, Key, ContentType: mimeType }),
);
// created.UploadId

const partUrl = await getSignedUrl(
  client,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);
// client PUTs the part bytes directly to partUrl — bytes never pass through the NestJS API

await client.send(
  new CompleteMultipartUploadCommand({
    Bucket,
    Key,
    UploadId,
    MultipartUpload: { Parts: [{ PartNumber, ETag }, ...] },
  }),
);
```

`StorageService.createMultipartUpload` wraps the create + per-part presigned URL generation; `StorageService.completeMultipartUpload` wraps the complete call with `Parts` sorted by `PartNumber` (S3 rejects out-of-order parts).

### Presigned GET (streaming / download)

```typescript
const url = await getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), {
  expiresIn: 3600,
});
```

Passing `ResponseContentDisposition: 'attachment; filename="..."'` on the `GetObjectCommand` input makes the presigned URL force a download with that filename — used by the `/videos/:id/download` endpoint; the `/videos/:id/stream` endpoint omits it so the browser plays the video inline via HTTP range requests, which S3/MinIO's object GET already supports natively (206 Partial Content).

### MinIO compatibility

The S3 client is constructed with `endpoint`, `forcePathStyle: true`, and static credentials pointing at the `minio` Docker service — the same `@aws-sdk/client-s3` API works unmodified against MinIO because MinIO implements the S3 API; only the client construction (endpoint + path-style addressing) differs from talking to real AWS S3.
