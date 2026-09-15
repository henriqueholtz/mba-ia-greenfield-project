# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — SMTP + web UI for captured emails
- `minio` — S3-compatible object storage (video files + thumbnails), API port `9000`, console port `9001`
- `redis` — backs the BullMQ video-processing queue, port `6379`
- `video-worker` — separate container running the BullMQ worker (`src/worker.ts`), consumes `video-processing` jobs

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.

## Videos Module (Phase 03)

Video upload, background processing, storage, streaming and download. Belongs to a channel (1:1 with the uploading user's channel). Implemented in `src/videos/`, `src/storage/`, `src/queue/`, plus the worker entrypoint `src/worker.ts`.

### Upload strategy — presigned multipart, never through the API

A 10GB file is never streamed through the NestJS API. `POST /videos` pre-registers the video as `draft`, opens an S3 multipart upload against MinIO, and returns presigned per-part PUT URLs; the client uploads bytes directly to MinIO. `POST /videos/:id/complete-upload` receives the client-reported ETags, calls `CompleteMultipartUploadCommand`, transitions the video to `processing`, and enqueues the `video.process` BullMQ job — all in the same request/transaction.

### Status lifecycle

`Video.status: 'draft' | 'processing' | 'ready' | 'failed'` (`src/videos/entities/video.entity.ts`). `draft` on pre-registration → `processing` on `complete-upload` → `ready` on successful worker processing, or `failed` with `failure_reason` populated on worker error. There is no retry state; a failed video stays `failed`.

### Queue and worker (BullMQ + Redis)

`@nestjs/bullmq` registers the `video-processing` queue (`src/queue/queue.module.ts`, constants in `queue.constants.ts`). `VideosService` injects the `Queue` producer and calls `.add('video.process', { videoId, storageKey })`. The consumer, `VideoProcessor` (`src/videos/video.processor.ts`), is a `@Processor(VIDEO_PROCESSING_QUEUE)` class extending `WorkerHost`; it runs in the separate `video-worker` container/process (`src/worker.ts` → `WorkerModule`), never inside the `nestjs-api` container. Both containers connect to the same `redis` service.

### Processing (FFmpeg)

`VideoProcessorService` (`src/videos/video-processor.service.ts`) downloads the source from storage to a local temp file, runs `ffprobe` to extract `duration_seconds`, `video_codec`, `width`, `height`, `file_size_bytes`, `mime_type`, and generates a thumbnail via `fluent-ffmpeg`'s `screenshots()` (50% mark), then uploads the thumbnail back to storage. `VideoProcessor` (the BullMQ consumer) calls this service, updates the `Video` row on success (`status: 'ready'` + extracted metadata + `thumbnail_key`), and on failure sets `status: 'failed'` with `failure_reason` — always caught and persisted, never left as an unhandled rejection in the worker process. See `docs/phases/phase-03-videos/library-refs.md` for fluent-ffmpeg usage details.

### Object storage (MinIO / S3-compatible)

`StorageService` (`src/storage/storage.service.ts`) wraps `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, configured via `storage.config.ts` to point at the `minio` Docker service with `forcePathStyle: true` (same API surface as real S3; swap the endpoint/credentials for production). Storage keys follow `videos/<slug>/original` and `videos/<slug>/thumbnail.png`. Presigned GET URLs back both streaming (`GET /videos/:id/stream`, inline, range requests handled natively by S3/MinIO for 206 Partial Content) and download (`GET /videos/:id/download`, `ResponseContentDisposition: attachment`).

### Unique URL

Each video has a random unique `slug` column (`src/videos/slug.util.ts` generates it; collisions are retried with a fresh slug and, for the DB-level race, a Postgres unique-violation retry loop). `GET /videos/:slug` is the public detail endpoint.

### Endpoints (Authorization Matrix summary — full contract in `docs/phases/phase-03-videos/phase-03-videos.md`)

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /videos` | JWT required | Pre-registers draft, returns presigned part URLs |
| `POST /videos/:id/complete-upload` | JWT required, owner-only | Completes multipart upload, enqueues processing |
| `GET /videos/:id/stream` | `@Public()` | Redirects to a presigned GET URL, range-request streaming |
| `GET /videos/:id/download` | `@Public()` | Redirects to a presigned GET URL with attachment disposition |
| `GET /videos/:slug` | `@Public()` | Video metadata + `thumbnail_url` (null until `ready`) |

### Migration

`src/database/migrations/<timestamp>-CreateVideos.ts` creates the `videos` table (FK to `channels`).
