---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-09-14
scope_description: "Video upload, background processing (queue + worker), storage layout, streaming, unique URLs, and status lifecycle for Phase 03"
---

> Context7 MCP note: `nestjs-project/CLAUDE.md`/root `CLAUDE.md` mandate consulting Context7 before implementing with any library. The repo's `.mcp.json` currently only configures the `postgres` MCP server — no `context7` server is registered in this environment. This research used WebSearch/official docs as a fallback. Add the `context7` MCP server before `/implement` runs, or flag this gap explicitly if it stays unavailable.


# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — receives the new `videos` module, storage integration, queue producer, a video worker, the `Video` migration, and the streaming/download endpoints. All TDs below apply here.
- `next-frontend/` — not yet initialized; explicitly out of scope for this phase per `docs/project-plan.md` (Fase 03 delivers no UI — video viewing/management UI is Fase 04/05). No TD in this document.

---

## TD-01: Background Processing Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** `docs/diagrams/software-arch.mermaid` explicitly marks the Message Queue as `"TBD"`. Video processing (metadata/duration extraction, thumbnail generation) must run asynchronously so the upload-completion response is never blocked on FFmpeg work. The API must publish a job when an upload completes; a separate worker must consume it and update the video's status in PostgreSQL.

**Options:**

### Option A: BullMQ + Redis
- A NestJS-native queue library (`@nestjs/bullmq`) backed by Redis; the API pushes jobs to a queue, the worker registers a `Processor`/`WorkerHost` consuming them, with built-in retries, backoff, concurrency limits, and job status introspection.
- **Pros:** first-class NestJS integration (`@nestjs/bullmq`), mature retry/backoff/DLQ semantics out of the box, easy local Bull Board UI for debugging job state, decouples worker from HTTP framework (can run as a separate Nest "application context" process), widely documented for exactly this video-processing-worker pattern.
- **Cons:** introduces Redis as a new infrastructure dependency (new Compose service) purely for queueing — no other part of the stack currently needs Redis.

### Option B: PostgreSQL-backed queue (e.g., `pg-boss`)
- Uses `SKIP LOCKED` polling on a jobs table in the existing PostgreSQL database; no new infrastructure service.
- **Pros:** zero new infra — reuses the already-running `db` service; transactional job enqueue (can enqueue in the same transaction as the video draft insert).
- **Cons:** weaker ecosystem/tooling than BullMQ (no dashboard as mature as Bull Board), adds polling load to Postgres, less idiomatic for a "message queue" container as explicitly modeled in the architecture diagram (the diagram draws Queue and Database as separate containers).

### Option C: RabbitMQ
- A dedicated AMQP broker; NestJS has built-in microservices transport support for RabbitMQ.
- **Pros:** strong pub/sub and routing semantics, industry-standard message broker, exactly matches "Message Queue" as a distinct architectural container.
- **Cons:** heavier operationally (exchange/queue/binding concepts) than this phase's single-job-type use case needs; no clear advantage over BullMQ for a single point-to-point job (API → one worker) with no fan-out/routing requirement.

**Recommendation:** **BullMQ + Redis (Option A)** — the project already inherits NestJS module conventions everywhere (`@nestjs/config`, `@nestjs/jwt`, `@nestjs/throttler`), and `@nestjs/bullmq` extends that same DI-based pattern with the least new conceptual surface. The architecture diagram models the queue as its own container, which BullMQ+Redis satisfies directly (unlike Option B, which would fold the queue into the existing DB container, contradicting the diagram). RabbitMQ's routing/fan-out strength (Option C) is unused by this phase's single job type, so it adds ceremony without benefit over BullMQ.

**Decision:** A (BullMQ + Redis)

---

## TD-02: Upload Strategy for Files up to 10GB

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The Definition of Done explicitly fails the phase if a 10GB file is passed through the API in a way that blocks the system. The API must not buffer or stream the full file body through its own process/memory. This decision also fixes how object storage is *used* (bucket/key layout, presigned flow) — the storage backend itself (S3-compatible / MinIO locally) is already fixed by the project plan and is not an open choice here.

**Options:**

### Option A: Presigned PUT URL (single-shot)
- API pre-registers the video as a draft, asks the storage service for one presigned `PutObject` URL scoped to a generated storage key, and returns it to the caller; the client uploads the entire file directly to storage using that URL, then notifies the API when done (or the API polls/receives a storage event).
- **Pros:** simplest to implement and to test in Compose; API never touches file bytes; works uniformly for MinIO and S3.
- **Cons:** a single PUT presigned URL is not resumable — a dropped connection on a 10GB upload restarts from zero; AWS/S3-compatible presigned PUT is also capped well under 10GB in practice for a single request without chunking.

### Option B: Presigned multipart upload (chunked)
- API pre-registers the draft, initiates a multipart upload (`CreateMultipartUpload`), returns presigned URLs per part (e.g., 5–100MB chunks) for the client to PUT directly to storage, then the client (or a completion callback) calls `CompleteMultipartUpload` via the API once all parts succeed.
- **Pros:** supports resuming a failed/interrupted upload from the last successful part (satisfies `docs/project-plan.md` §4's "permita retomar em caso de falha de conexão"); no single-request size cap; scales cleanly to 10GB and beyond; S3-compatible API (works with MinIO, which supports the multipart API).
- **Cons:** more moving parts than Option A — API must track part ETags and orchestrate `CompleteMultipartUpload`; client-side upload logic must implement chunking and per-part retry (this project's Phase 03 is backend-only, so this logic is exercised by tests/tooling rather than a real frontend in this phase).

### Option C: Stream the upload through the NestJS API (multipart/form-data or raw stream)
- The client uploads to a Nest endpoint; the API streams the request body directly to storage without buffering to disk/memory (e.g., piping the incoming stream into the S3 SDK's streaming upload).
- **Pros:** simplest client contract (one HTTP call to the API, no separate storage credentials exposed to the client).
- **Cons:** ties up an API process/connection for the full duration of a up-to-10GB transfer, multiplied by concurrent uploads — this is exactly the "travels through the API and blocks the system" failure mode the assignment explicitly calls out as automatic-fail territory, even with streaming (no buffering) because connection/worker slots and API compute are still consumed proportionally to transfer time.

**Recommendation:** **Presigned multipart upload (Option B)** — it is the only option that satisfies both hard constraints simultaneously: never routing the byte stream through the API (ruling out Option C) and supporting resume-on-failure for a 10GB transfer (ruling out Option A's single-shot cap and lack of resumability). MinIO's S3-compatible API supports the multipart upload lifecycle natively, so no divergent code path is needed between local MinIO and a future production S3 bucket.

**Decision:** B (Presigned multipart upload)

---

## TD-03: Video Worker Runtime Architecture

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** `docs/diagrams/software-arch.mermaid` models "Video Worker" as a distinct container from the API, consuming from the queue, reading/writing storage, and updating the database directly. This decision fixes how that worker is packaged and run — same codebase as a second entry point vs. a fully separate application — and how it invokes FFmpeg/ffprobe.

**Options:**

### Option A: Second entry point in the same NestJS codebase, separate container
- The worker is a second `main.ts`-style bootstrap (e.g., `src/worker.ts`) inside `nestjs-project/`, sharing the same `VideosModule`/entities/TypeORM connection code, registered as a BullMQ `WorkerHost` processor. It runs as its own `compose.yaml` service built from the same image/Dockerfile but with a different start command (`node dist/worker.js` instead of `node dist/main.js`).
- **Pros:** reuses the same `Video` entity, repository, DTOs, and TypeORM data source config as the API — no duplication or drift between how the API and worker read/write video rows; single `package.json`/dependency set to manage; matches this project's "one backend codebase" structure to date.
- **Cons:** the worker container needs FFmpeg installed even though it's the same base image as the (FFmpeg-free) API — requires either two Dockerfiles or one Dockerfile with FFmpeg installed unconditionally (slightly larger API image than strictly necessary).

### Option B: Fully separate worker application/repository
- The worker is an independent Node.js (or other language) service with its own codebase, its own DB access layer, and its own deployment artifact, communicating with the API only through the queue and the database.
- **Pros:** clean deployment isolation; worker could be written in a language better suited to CPU-bound FFmpeg orchestration.
- **Cons:** duplicates the `Video` entity/schema knowledge in a second codebase (drift risk on every migration), contradicts the phase's "continuity, not rewrite" instruction (`Prompt.md`: "Continuidade, não retrabalho"), and this project has no existing multi-codebase-backend precedent to extend.

**Recommendation:** **Second entry point, same codebase, separate container (Option A)** — it reuses the `Video` TypeORM entity and repository/service layer the `videos` module already defines for the API, eliminating any schema-drift risk between producer and consumer, and fits the project's single-backend-codebase convention established in Phases 01–02. The extra image size from bundling FFmpeg is a one-time, acceptable cost versus maintaining a second codebase.

**Decision:** A (Second entry point, same codebase, separate container)

**Note:** Metadata fields extracted via ffprobe and persisted on the `Video` entity: `duration_seconds`, `video_codec`, `width`, `height`, `file_size_bytes`, `mime_type`. This is the concrete field list resolving AMB-1 from `validation.md` — `docs/project-plan.md` only names "duração" explicitly; the remaining fields are the minimal set ffprobe returns in a single pass that is useful for playback/streaming and basic video info.

---

## TD-04: Video Status Lifecycle and Failure Handling

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** The video row must track its progress from "just started uploading" to "ready to stream," and the system must have a defined, queryable state for when FFmpeg processing fails (corrupt file, unsupported codec, worker crash). `Prompt.md` explicitly requires this cycle to be reflected in the database and the plan's Error Catalog / Data Model to define it.

**Options:**

### Option A: Four-state linear lifecycle — `draft → processing → ready → failed`
- `draft` is set the instant the upload is initiated (pre-registration, before any bytes arrive); the API transitions to `processing` when the multipart upload is completed and the job is enqueued; the worker transitions to `ready` on successful FFmpeg extraction + thumbnail generation, or to `failed` (storing an error reason column) on any processing exception, with no automatic retry beyond BullMQ's built-in job retry/backoff (chosen in TD-01).
- **Pros:** exactly matches the four states implied by `Prompt.md`'s own wording ("rascunho → processando → pronto/erro"); simple enough to model as a Postgres enum column; every transition has exactly one owner (API owns draft→processing, worker owns processing→ready/failed).
- **Cons:** does not distinguish "upload never completed" (abandoned draft) from "upload completed, processing pending" — both sit in intermediate states without a distinct timeout/cleanup story, but that reconciliation job is explicitly out of scope for this phase (no cleanup capability listed in Fase 03's bullets).

### Option B: Fine-grained state machine (e.g., `draft → uploading → uploaded → queued → processing → ready`/`failed`, with sub-states for metadata vs thumbnail)
- Separate states for each pipeline step, potentially with independent columns for "metadata extracted" and "thumbnail generated."
- **Pros:** more observability into exactly which processing step is in flight or failed.
- **Cons:** materially more states than the project-plan's own vocabulary describes, more transitions to test and keep consistent, and no capability bullet in Fase 03 asks for per-step observability — this is speculative granularity the phase doesn't require.

**Recommendation:** **Four-state linear lifecycle (Option A)** — it is literally the vocabulary `docs/project-plan.md` uses ("rascunho → processando → pronto/erro"), covers every capability this phase lists, and keeps the Data Model/Error Catalog small and testable. Option B's extra granularity has no traceable capability driving it (fails the capability gate) and is exactly the kind of speculative future-proofing the project's working principles warn against.

**Decision:** A (Four-state linear lifecycle)

**Note:** The `draft → processing` transition and BullMQ job enqueue are triggered by a single API-orchestrated step: the client calls one API endpoint (e.g., `POST /videos/{id}/complete-upload`) passing the collected part ETags; that handler itself calls storage's `CompleteMultipartUpload`, then — in the same request, atomically — transitions the video's status to `processing` and enqueues the processing job. This is the concrete trigger resolving AMB-2 from `validation.md`; it keeps the multipart-completion, status transition, and enqueue as one API-owned unit of work rather than a two-step client-orchestrated handoff.

---

## TD-05: Unique Video URL Strategy

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a short, collision-free public identifier. The existing `Channel` entity already solves an analogous problem for channel nicknames (`ChannelsService` pre-checks then retries on a Postgres unique-violation, `23505`, up to a bounded retry count) — this decision is whether Phase 03 reuses that exact pattern or picks a different generation strategy for videos specifically.

**Options:**

### Option A: The video's own UUID primary key doubles as the unique URL identifier
- The public video URL is simply `/videos/{id}` where `{id}` is the entity's `@PrimaryGeneratedColumn('uuid')`, already guaranteed unique by Postgres.
- **Pros:** zero extra code — uniqueness is a database guarantee already in place for every entity in the project; no retry/collision logic needed at all.
- **Cons:** UUIDs are long and not "short" in the sense `docs/project-plan.md` §4 implies ("URL curta e única"); not human-shareable/memorable.

### Option B: Short generated slug column with collision retry, mirroring `ChannelsService`'s nickname pattern
- A separate `slug`/`public_id` column (e.g., 8–10 char base62 string) generated at draft-creation time, with the same pre-check-then-catch-`23505`-then-retry pattern `ChannelsService` already implements for `nickname`.
- **Pros:** short, URL-friendly identifier; directly reuses an established, already-tested project pattern (same retry bound, same exception-driven collision handling) rather than inventing a new one — satisfies "Continuidade, não retrabalho."
- **Cons:** one extra column + one extra small piece of generation logic per video (though it is a near-identical copy of existing, proven code).

**Recommendation:** **Short generated slug with collision retry (Option B)** — `docs/project-plan.md` §4 explicitly asks for a short URL ("URL curta"), which a raw UUID (Option A) does not provide, and the project already has a working, tested collision-retry implementation in `ChannelsService` for exactly this shape of problem (generate → check → retry-on-23505). Reusing that pattern is a direct application of the project's "Continuidade, não retrabalho" instruction rather than introducing a new one.

**Decision:** B (Short generated slug with collision retry)

---

## TD-06: Streaming Delivery Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** The architecture diagram shows the frontend streaming directly from Object Storage ("Rel(frontend, storage, 'Streams', 'HTTPS')"), while the API is only responsible for uploads and business rules. This decision fixes whether the video file is served to viewers through the NestJS API (with HTTP Range support) or the API only hands out a direct/presigned storage URL and storage itself serves the range requests.

**Options:**

### Option A: API proxies streaming, implementing HTTP Range / 206 Partial Content itself
- A NestJS controller reads the object from storage as a stream and re-serves it to the client, parsing the `Range` header and responding with `206 Partial Content` and `Content-Range` for partial reads.
- **Pros:** API stays the single point of control (can enforce auth/visibility rules per request, e.g., unlisted-video access checks slated for Phase 04).
- **Cons:** contradicts the architecture diagram's explicit `frontend → storage` streaming relationship; re-introduces exactly the kind of long-lived, per-request data pass-through the upload decision (TD-02) was designed to avoid — every concurrent viewer now holds an API connection/stream for the duration of playback.

### Option B: API returns a presigned/direct GET URL; storage serves Range requests natively
- The API's "watch" and "download" endpoints validate the request and respond with a presigned (or public, depending on bucket policy) GET URL pointing at the object in storage; the client's `<video>` tag or download manager talks directly to storage, which natively supports `Range` requests (S3/MinIO both do).
- **Pros:** matches the architecture diagram exactly; storage (built for exactly this) handles Range/206 semantics instead of reimplementing them in the API; no per-viewer long-lived API connection, consistent with the non-blocking principle applied to upload.
- **Cons:** since this phase has no frontend UI, the "download" and "streaming" endpoints are verified via the API contract and e2e tests (Range-request pass-through validation against the actual MinIO container) rather than a real player; presigned GET URLs need a sensible expiry that doesn't interrupt long playback sessions.

**Recommendation:** **Presigned/direct GET URL, storage serves Range requests (Option B)** — it is the only option consistent with the architecture diagram's explicit `frontend → storage` streaming relationship and avoids reintroducing an API-side bottleneck for concurrent playback, mirroring the same non-blocking rationale already applied to the upload decision (TD-02). Both MinIO and S3 implement `Range`/`206 Partial Content` natively, so no custom streaming code needs to be written or tested at the API layer.

**Decision:** B (Presigned/direct GET URL, storage serves Range requests)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Background Processing Queue Technology | BullMQ + Redis | A (BullMQ + Redis) |
| TD-02 | Backend | Upload Strategy for Files up to 10GB | Presigned multipart upload | B (Presigned multipart upload) |
| TD-03 | Backend | Video Worker Runtime Architecture | Second entry point, same codebase, separate container | A (Second entry point, same codebase, separate container) |
| TD-04 | Backend | Video Status Lifecycle and Failure Handling | Four-state linear lifecycle (draft → processing → ready/failed) | A (Four-state linear lifecycle) |
| TD-05 | Backend | Unique Video URL Strategy | Short generated slug with collision retry | B (Short generated slug with collision retry) |
| TD-06 | Backend | Streaming Delivery Strategy | Presigned/direct GET URL, storage serves Range requests | B (Presigned/direct GET URL, storage serves Range requests) |
