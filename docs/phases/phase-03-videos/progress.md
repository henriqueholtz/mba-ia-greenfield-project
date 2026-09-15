# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

### SI-03.1 — Infra: object storage, fila e worker no Compose
- **Status:** completed
- **Tests:** no tests (infra)
- **Observations:**
  - `video-worker` compose service references `npm run worker:start:dev`, which does not exist yet — it will crash-loop until SI-03.6 adds the script and `src/worker.ts`. This is expected per the Dependency Map's incremental build order; `video-worker` was not started in this SI's verification.

### SI-03.2 — Migration + entidade Video
- **Status:** completed
- **Tests:** 8 passing
- **Observations:**
  - `migrations.integration-spec.ts`'s `beforeAll` dropped managed tables via `Promise.all` (concurrent `DROP TABLE ... CASCADE`), which deadlocked in Postgres under this connection; changed to sequential drops.
  - `DROP TABLE ... CASCADE` does not drop dependent Postgres enum types (only the reverse cascades). The pre-existing `verification_tokens_type_enum` was never cleaned between runs — a latent flaw that surfaced now because rerunning the suite hit "type already exists". Fixed by explicitly dropping both `verification_tokens_type_enum` and the new `videos_status_enum` in `beforeAll`. This also protects future added enum-typed migrations from the same class of failure, but no other enum types exist yet to retrofit.
  - `pg` driver emits a `DeprecationWarning: Calling client.query() when the client is already executing a query` during `video.entity.integration-spec.ts` — non-fatal, does not fail tests; likely an unawaited query somewhere in the shared test data-source helper or TypeORM's driver internals. Out of scope for this SI; flagging for future investigation if it becomes a real issue.

### SI-03.3 — VideosModule + StorageService (presigned multipart)
- **Status:** completed
- **Tests:** 13 passing
- **Observations:**
  - No library was explicitly named by TD-02/TD-06 for the S3-compatible client; installed `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (v3, current per context7) as the standard SDK for presigned multipart operations against MinIO, configured with `forcePathStyle: true` per AWS SDK v3's own MinIO/S3-compatible-endpoint guidance.
  - Created an empty `VideosController` shell in this SI (not listed as its own artifact in SI-03.3's Technical actions) because SI-03.3's action #2 says the module "declara VideosService e VideosController", and SI-03.4's actions read as adding endpoints to an already-existing controller rather than creating the file. If this reading is wrong, SI-03.4 can absorb/rename it without issue since it's currently empty.
  - The MinIO bucket (`streamtube-videos`) did not exist after SI-03.1's infra setup — created it manually via `docker compose exec minio mc mb`. SI-03.1's Technical actions covered the compose service but not bucket bootstrapping; flagging as a gap in that SI's scope in case the team wants an automated bucket-init step (e.g., a `mc mb` init container) for fresh environments instead of a manual one-time step.
  - Part size for multipart planning is a hardcoded 100MB constant in `VideosService` (`PART_SIZE_BYTES`) — not specified by any TD; chosen as a reasonable default within S3/MinIO's part-size bounds (5MB–5GB) and comfortably scales a 10GB file to ~100 parts, well under the 10,000-part API limit.

### SI-03.4 — Endpoints de upload: POST /videos e POST /videos/{id}/complete-upload
- **Status:** completed
- **Tests:** 9 passing (E2E)
- **Observations:**
  - This SI's Technical actions require throwing `VideoNotFoundException` and `VideoAlreadyProcessedException`, both defined by SI-03.8. Reordered execution to implement SI-03.8 first (see its own Observations entry) — user confirmed this was the right call.
  - The plan named NestJS's built-in `ForbiddenException` for the ownership check, but `nestjs-services.md` forbids services from throwing HTTP exceptions (domain exceptions only, mapped by the global filter), and the Error Catalog table has no FORBIDDEN entry. Added a new `VideoForbiddenException` (`VIDEO_FORBIDDEN`, 403) to `domain.exception.ts` instead, keeping the service layer consistent with the rest of the codebase. User confirmed this approach.
  - `POST /videos` needs to resolve the caller's `channel_id` from the JWT's `sub`, but `ChannelsService` only had `createChannel` (no lookup-by-user) and `ChannelsModule` was not registered anywhere reachable from `AppModule`. Added `ChannelsService.findByUserId(userId)` and imported `ChannelsModule` into `VideosModule`. This is a minimal, surgical fix scoped to unblocking this SI — user confirmed this over treating it as a separate pre-existing-gap task.
  - `videos.e2e-spec.ts`'s success-path test for `complete-upload` performs a **real** multipart part upload against MinIO (via `fetch` to the presigned PUT URL) to obtain a genuine ETag, rather than mocking `StorageService` — this proves the full presigned-URL round-trip actually works end-to-end, consistent with TD-02's real-multipart-semantics intent.
  - `npm run lint` reports pre-existing baseline errors unrelated to this SI (confirmed by lint output on `channels.service.ts` and `test/auth.e2e-spec.ts`, both untouched by this phase) — mostly `@typescript-eslint/no-unsafe-*` on `any`-typed `QueryFailedError` casts and `supertest`'s untyped `res.body`. My new files (`videos.service.ts`, `videos.e2e-spec.ts`) mirror the exact same pre-existing patterns for consistency rather than diverging with a one-off fix. Flagging for the team in case a project-wide lint cleanup is ever scheduled.

### SI-03.5 — Fila BullMQ: módulo + producer
- **Status:** completed
- **Tests:** 15 passing (unit + integration) + 9 e2e re-verified (no regressions)
- **Observations:**
  - `@nestjs/bullmq` and `@nestjs/bull-shared` ship as ESM-only packages (`"type": "module"` in their package.json), which Jest's default CommonJS transform cannot parse — every suite importing anything from `videos.service.ts`/`videos.module.ts`/`queue.module.ts` failed with `SyntaxError: Unexpected token 'export'`. Fixed by adding `transformIgnorePatterns` to both `package.json`'s `jest` config and `test/jest-e2e.json`, allowing ts-jest to transform those two packages instead of treating them as opaque `node_modules`. `bullmq` itself ships a CJS entry point and needed no such override.
  - `bullmq`'s `Queue` constructor has `ioredis` as an optional peer dependency it loads dynamically at runtime — installing `bullmq` alone was not enough; real `Queue` instantiation (in the integration test and in `QueueModule`'s DI-driven registration) threw `BullMQ could not load the optional 'ioredis' package` until `ioredis` was explicitly installed.
  - Enqueue happens synchronously in the same `completeUpload` call that persists `status: 'processing'` (not wrapped in a DB transaction with it, since BullMQ enqueue is not a DB operation) — this satisfies TD-04's Note ("mesma chamada... atomicamente") in the sense of "one request handler, one unit of work," not a two-phase-commit sense; a failure between the DB save and the enqueue call would leave the video `processing` with no queued job. No compensating logic was added since the plan doesn't call for one and no capability bullet asks for it — flagging as a known gap if reconciliation/retry tooling is ever prioritized.
  - `videos.service.integration-spec.ts` now spins up a real `Queue` connected to the Compose `redis` service and drains/obliterates it in `beforeEach`/`afterAll` to keep test runs isolated — mirrors the "fila real via Compose, não mock" requirement from this SI's Tests table.

### SI-03.6 — Video worker: consumer BullMQ + processamento FFmpeg
- **Status:** completed
- **Tests:** 4 passing (integration) + 12 re-verified (no regressions)
- **Observations:**
  - **Significant bug caught mid-SI:** `nest start worker --watch` (the script SI-03.1 pre-wired into `compose.yaml`'s `video-worker` service) does NOT select `src/worker.ts` as the entry point. The CLI's positional `[app]` argument to `nest start` only resolves a named project inside a monorepo-style `nest-cli.json` `projects` map; this project has no such map (single-app mode), so `nest start worker` silently falls back to the default `main.ts`/`AppModule` entry instead of erroring. Result: `video-worker`'s container had been booting the full HTTP API (mapping `/auth/*`, `/videos` routes) instead of consuming the queue, completely undetected until logs were inspected directly. Fixed by rewriting `worker:start:dev` to use `ts-node-dev --respawn --transpile-only -r tsconfig-paths/register src/worker.ts` (new devDependency: `ts-node-dev`), which runs the exact file directly instead of going through nest-cli's app-name resolution. `worker:start:prod` (`node dist/worker.js`) was already correct since a plain `nest build`/`tsc` compiles every file under `src/` regardless of the CLI's "app" concept — only the dev/watch path was broken. **Verified the fix** by restarting the `video-worker` compose service and confirming its logs show `WorkerModule`/`VideosModule` init and the custom "Video worker started, consuming video-processing queue" line, with no HTTP routes mapped.
  - `WorkerModule` needed `UsersModule` in its imports even though the worker's own code never touches `User` directly — TypeORM's `autoLoadEntities: true` only registers entities reachable via some `TypeOrmModule.forFeature()` call in the current app's module graph, and `Channel`'s `@OneToOne(() => User, ...)` inverse relation requires `User`'s entity metadata to be present or `DataSource.initialize()` throws `TypeORMError: Entity metadata for Channel#user was not found`. This only surfaces when a slimmer module tree (worker) omits a module the full API (`AppModule` → `AuthModule` → ... → `UsersModule`) always pulls in transitively.
  - `ffmpeg-static` was installed per this SI's explicit instruction, but is not actually wired in — the system already has real `ffmpeg`/`ffprobe` on PATH via the `apt install ffmpeg` from SI-03.1's `Dockerfile.dev` change, and `fluent-ffmpeg` auto-detects PATH binaries by default. `ffmpeg-static` only bundles an `ffmpeg` binary (no `ffprobe`), so wiring it in via `setFfmpegPath` while `ffprobe` still resolves from apt would mean two different `ffmpeg` binaries in play for no benefit — left the package installed (as instructed) but unused, deferring to the single apt-installed toolchain for consistency between `ffmpeg` and `ffprobe`.
  - Created two tiny test video fixtures under `src/videos/fixtures/` (`test-video.mp4` ~30KB, a synthetic 2s clip generated via `ffmpeg -f lavfi`; `corrupted-video.mp4` ~40 bytes, plain text with a `.mp4` extension) for the integration tests to exercise real ffprobe/FFmpeg success and failure paths without depending on an external asset.
  - `VideoProcessor.process` catches processing exceptions and logs+persists `status: 'failed'` without rethrowing — this is the documented exception in `nestjs-services.md` for background/queue-consumer contexts (rethrowing would just retry an unfixable corrupt-file error per BullMQ's retry policy from TD-01, and the domain requirement per TD-04 is exactly "no automatic retry beyond BullMQ's built-in retry/backoff").

### SI-03.7 — Endpoints de streaming, download e leitura por slug
- **Status:** completed
- **Tests:** 20 passing (e2e, full videos.e2e-spec.ts suite) + 11 re-verified (no regressions)
- **Observations:**
  - `GET /videos/:id/stream`, `GET /videos/:id/download`, and `GET /videos/:slug` are all anonymous per the Authorization Matrix — added `@Public()` on each, overriding the global JWT guard default.
  - The `GET /videos/:slug` route sits after `GET /videos/:id/stream` and `GET /videos/:id/download` in the controller (declaration order matches path specificity: `:id/stream` and `:id/download` match two path segments, `:slug` alone matches one) — no route collision since Express/Nest resolve by segment count and literal suffix, not first-match-wins on the parameter name alone.
  - E2E success-path tests for stream/download construct a `ready` video directly via the repository (uploading the real test fixture to MinIO first, then flipping `status` to `ready`) rather than waiting on the real `video-worker` container to finish processing asynchronously — deterministic and fast, and still exercises the real presigned-URL + Range-request round trip against MinIO. The actual worker path (draft → processing → ready via real FFmpeg) is already covered by SI-03.6's `video.processor.integration-spec.ts`; re-deriving it here via the async worker would be redundant and flaky (timing-dependent).
  - Confirmed the download endpoint's presigned URL carries `response-content-disposition` as a query parameter (S3/MinIO's presigned-URL convention for `ResponseContentDisposition`), verified via an e2e assertion on `res.headers.location`.

### SI-03.8 — Domain exceptions de vídeo
- **Status:** completed
- **Tests:** 3 passing
- **Observations:**
  - Implemented out of document order (before SI-03.4, not after SI-03.7) because SI-03.4's Technical actions require throwing `VideoNotFoundException` and `VideoAlreadyProcessedException`, both defined by this SI. The plan's Dependency Map lists SI-03.8 as independent/last, but that's inconsistent with SI-03.4's actual code dependency on these classes — flagging this as a plan authoring gap for future phases (an SI whose exceptions are consumed by an earlier-numbered SI should be sequenced before it, or explicitly marked as a Dependencies entry for that SI). User confirmed reordering was the right call over stopping to revise the plan.
  - No filter changes needed: `DomainExceptionFilter` (`src/common/filters/domain-exception.filter.ts`) already catches any `DomainException` subclass generically via `@Catch(DomainException)` — new exceptions only needed their own class definitions, not filter wiring.

## Final Verification

All plan-level Deliverables checks pass:

- **Unit + integration tests:** 32/32 suites, 177/177 tests passing (`docker compose exec nestjs-api npm test -- --runInBand`)
- **E2E tests:** 4/4 suites, 72/72 tests passing, confirmed stable across 3 consecutive runs (`docker compose exec nestjs-api npm run test:e2e`)
- **Type-check:** `npx tsc --noEmit` exits 0
- **Lint:** pre-existing baseline debt only (see SI-03.4 observation) — no new categories of error introduced by this phase; the one genuinely new-code lint issue (`prefer-promise-reject-errors` in `video-processor.service.ts`) was fixed during final verification.

Three real regressions were found and fixed during final verification (none were visible from any single SI's own scoped tests — all three only surfaced when running the **full** suite together, which is exactly why this step exists):

1. **`Video.channel`'s `@ManyToOne` was missing its inverse-relation callback** (`(channel) => channel.videos`) — without it, TypeORM cannot resolve `Channel.videos`' inverse side, and `DataSource.initialize()` throws `TypeORMError: Entity metadata for Channel#videos was not found` for **any** DataSource that loads both entities. This broke 10 pre-existing test files project-wide (auth, users, channels module/entity/service specs) that hadn't been touched by this phase but share the `Channel` entity. Fixed `video.entity.ts`, and added `Video` to all 10 affected files' scoped `ALL_ENTITIES` test fixtures (a direct, mechanical consequence of correctly wiring the relation — every DataSource that includes `Channel` now must also include `Video`).
2. **`env.validation.integration-spec.ts`'s shared `requiredEnv` test fixture was missing `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`**, which SI-03.1 made required in the Joi schema — broke 3 pre-existing `SWAGGER_ENABLED` tests. Fixed by adding both keys to the fixture.
3. **`cleanAllTables()` (the shared test-cleanup helper) didn't delete from `"videos"` before `"channels"`/`"users"`**, violating the new `videos.channel_id` FK whenever a suite left video rows behind — this broke `auth.e2e-spec.ts` intermittently whenever it ran after `videos.e2e-spec.ts` had populated the table. Fixed by adding `DELETE FROM "videos"` to `cleanAllTables` in FK-safe order (now safe for every caller since fix #1 means every caller's entity list includes `Video`).
4. **(Compounding factor for #3) `npm run test:e2e` had no `--runInBand` flag**, so Jest ran all 4 e2e spec files as separate parallel worker processes against the *same* shared Postgres test database — causing genuine cross-file race conditions (one file's cleanup deleting rows an in-flight request in another file depended on), independent of and on top of the FK-ordering bug in #3. This is why the failure was intermittent rather than 100% reproducible. Fixed by adding `--runInBand` to the `test:e2e` script, matching the project's own documented convention (`CLAUDE.md` states e2e "already configured" for serial execution — it wasn't). Verified stable across 3 consecutive full e2e runs post-fix.

None of these four issues were introduced maliciously or carelessly in isolation — each was invisible from the scope of the SI that touched the adjacent code, and only the full-suite final verification step (by design) surfaced them. This is the intended value of running Deliverables checks against the whole test suite rather than trusting per-SI green checkmarks alone.

## Pre-Submission DoD Cleanup

Folder/file naming was corrected to match the plan's contract (`docs/phases/phase-03-videos/`, `technical-decisions-phase-03-videos.md`, `phase-03-videos.md`), and `library-refs.md` was added (previously missing despite this phase fixing new libraries: BullMQ, fluent-ffmpeg, `@aws-sdk/client-s3`/`@aws-sdk/s3-request-presigner`).

`npm run lint` was reported as "pre-existing baseline debt only" in SI-03.4/Final Verification above — that debt (251 `@typescript-eslint/no-unsafe-*` errors project-wide, spanning both Phase 02 files untouched by this phase and this phase's own new files that mirrored the same pre-existing `any`-cast patterns) was fully eliminated as part of closing out this submission, since `npm run lint` passing is an explicit, unscoped Definition-of-Done gate — not just for code added in this phase. Fixed via:
- Typed `driverError: {code?, detail?}` reads on `QueryFailedError` (replacing `err as any`) in `videos.service.ts`, `channels.service.ts`, and their spec files' `makeUniqueError()` helpers.
- `jest.Mocked<Pick<T, ...>>`-typed mock factories (replacing untyped `any`-returning factories) across `videos.service.spec.ts`, `channels.service.spec.ts`, `auth.service.spec.ts`.
- Bracket-notation private-field access (`authService['mailService']`) replacing `(x as any).mailService` in e2e/integration specs that spy on injected services.
- Typed Mailpit API responses (`src/test/mailpit.ts`) replacing `any`/`any[]` returns.
- A real bug fix surfaced along the way: `auth.service.integration-spec.ts` queried `revoked_at: null` directly instead of `IsNull()` — per the project's own documented TypeORM pitfall (`.claude/rules/typeorm-queries.md`), a bare `null` in a `where` clause is silently dropped, so that assertion was checking a broader set of rows than intended. Fixed and re-verified green.
- A pre-existing platform issue was also found and fixed locally: `unrs-resolver` (a `jest-resolve` transitive dependency) was missing its Windows native binding after the repo's `node_modules` had been installed from inside the Linux container and bind-mounted to a Windows host, breaking `jest` when run from the host. Not a project code change — flagging in case CI or another contributor's host-side workflow hits the same `unrs-resolver`/napi-postinstall failure; the fix is a platform-specific `npm install @unrs/resolver-binding-<platform>` or a clean `rm -rf node_modules && npm install` run from the target platform.

Final state: `npx tsc --noEmit` exits 0, `npm run lint` exits 0 with zero errors and zero warnings, full suite (32 suites / 177 tests unit+integration, 4 suites / 72 tests e2e) green.
