---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-08-21T06:25:52.637409800-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-14T13:25:09.360231400-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-08-21T06:25:52.627101200-03:00"
  docs/phases/phase-02-auth/context.md: "2026-08-21T06:25:52.634408300-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-08-21T06:25:52.335339200-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Not specified explicitly in `docs/project-plan.md`'s Fase 03 block. Inferred from Fase 04's scope (edição de vídeo, categorias, visibilidade pública/unlisted, fluxo rascunho→publicação, painel de gerenciamento, edição de canal, página pública do canal) and Fase 05's scope (player/página de visualização): this phase delivers no frontend UI, no video metadata editing beyond auto-generated fields, no visibility toggle, no channel management panel.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project` — receives the new `videos` module, storage integration, queue producer, a video worker, the `Video` migration, and streaming/download endpoints.

**Deferred subprojects:**

- `next-frontend` — not yet initialized; explicitly out of scope for this phase (no UI capability listed).

**Sequencing notes:** Depende de: Fase 01, Fase 02.

**Neighbors (for boundary detection only):**

- **Phase 02:** Fase 02 — Cadastro, Login e Gerenciamento de Conta (Depende de: Fase 01)
- **Phase 04:** Fase 04 — Gerenciamento de Vídeos e Canal (Depende de: Fase 02, Fase 03)

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| upload-processing/TD-01 | phase | Backend | Background Processing Queue Technology | decided | A (BullMQ + Redis) | — |
| upload-processing/TD-02 | phase | Backend | Upload Strategy for Files up to 10GB | decided | B (Presigned multipart upload) | — |
| upload-processing/TD-03 | phase | Backend | Video Worker Runtime Architecture | decided | A (Second entry point, same codebase, separate container) | — |
| upload-processing/TD-04 | phase | Backend | Video Status Lifecycle and Failure Handling | decided | A (Four-state linear lifecycle) | — |
| upload-processing/TD-05 | phase | Backend | Unique Video URL Strategy | decided | B (Short generated slug with collision retry) | — |
| upload-processing/TD-06 | phase | Backend | Streaming Delivery Strategy | decided | B (Presigned/direct GET URL, storage serves Range requests) | — |

_Source files:_

- upload-processing — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | upload-processing/TD-02 |
| Serviço de processamento em segundo plano (filas) | upload-processing/TD-01, upload-processing/TD-03 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | upload-processing/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | upload-processing/TD-04 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | upload-processing/TD-03, upload-processing/TD-04 |
| Geração automática de thumbnail a partir de um frame do vídeo | upload-processing/TD-03 |
| URL única por vídeo, sem conflito com outros vídeos | upload-processing/TD-05 |
| Reprodução via streaming (sem necessidade de download completo) | upload-processing/TD-06 |
| Download do vídeo pelo usuário | upload-processing/TD-06 |

## Decisions Detail

### upload-processing/TD-01

**Recommendation:** the project already inherits NestJS module conventions everywhere (`@nestjs/config`, `@nestjs/jwt`, `@nestjs/throttler`), and `@nestjs/bullmq` extends that same DI-based pattern with the least new conceptual surface. The architecture diagram models the queue as its own container, which BullMQ+Redis satisfies directly (unlike Option B, which would fold the queue into the existing DB container, contradicting the diagram). RabbitMQ's routing/fan-out strength (Option C) is unused by this phase's single job type, so it adds ceremony without benefit over BullMQ.
**Libraries:** —

### upload-processing/TD-02

**Recommendation:** it is the only option that satisfies both hard constraints simultaneously: never routing the byte stream through the API (ruling out Option C) and supporting resume-on-failure for a 10GB transfer (ruling out Option A's single-shot cap and lack of resumability). MinIO's S3-compatible API supports the multipart upload lifecycle natively, so no divergent code path is needed between local MinIO and a future production S3 bucket.
**Libraries:** —

### upload-processing/TD-03

**Recommendation:** it reuses the `Video` TypeORM entity and repository/service layer the `videos` module already defines for the API, eliminating any schema-drift risk between producer and consumer, and fits the project's single-backend-codebase convention established in Phases 01–02. The extra image size from bundling FFmpeg is a one-time, acceptable cost versus maintaining a second codebase.
**Libraries:** —

### upload-processing/TD-04

**Recommendation:** it is literally the vocabulary `docs/project-plan.md` uses ("rascunho → processando → pronto/erro"), covers every capability this phase lists, and keeps the Data Model/Error Catalog small and testable. Option B's extra granularity has no traceable capability driving it (fails the capability gate) and is exactly the kind of speculative future-proofing the project's working principles warn against.
**Libraries:** —

### upload-processing/TD-05

**Recommendation:** `docs/project-plan.md` §4 explicitly asks for a short URL ("URL curta"), which a raw UUID (Option A) does not provide, and the project already has a working, tested collision-retry implementation in `ChannelsService` for exactly this shape of problem (generate → check → retry-on-23505). Reusing that pattern is a direct application of the project's "Continuidade, não retrabalho" instruction rather than introducing a new one.
**Libraries:** —

### upload-processing/TD-06

**Recommendation:** it is the only option consistent with the architecture diagram's explicit `frontend → storage` streaming relationship and avoids reintroducing an API-side bottleneck for concurrent playback, mirroring the same non-blocking rationale already applied to the upload decision (TD-02). Both MinIO and S3 implement `Range`/`206 Partial Content` natively, so no custom streaming code needs to be written or tested at the API layer.
**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS.
**Libraries:** `@nestjs/config`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — first-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring; handles string-to-number coercion natively.
**Libraries:** `joi`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped config with `registerAs`) — each domain's config isolated in its own file (`src/config/<domain>.config.ts`), typed injection via `ConfigType<typeof xConfig>`, scales naturally as new domains (auth, mail, storage, and now upload/video-processing) are added.
**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared `registerAs` factory) — natural outcome of TD-01/TD-03; the factory is callable directly by `data-source.ts` (after `dotenv.config()`) with zero duplication.
**Libraries:** —

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — documented NestJS approach; backend-only project so Zod's shared-schema advantage doesn't apply; project already uses decorators extensively.
**Libraries:** `class-validator`, `class-transformer`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — `{ statusCode, error, message }` response shape with machine-readable domain error codes; framework `HttpException`s pass through NestJS's default handling; this format is the contract for all subsequent phases including Phase 3.
**Libraries:** —

## Inherited Conventions

- TypeORM + PostgreSQL wired via `TypeOrmModule.forRootAsync()` with config injected from `databaseConfig` (never `TypeOrmModule.forRoot()` with hardcoded values) _(from phase 01)_
- Namespaced configuration files using `@nestjs/config` `registerAs()` pattern (`src/config/<domain>.config.ts`), each dual-purpose: DI injection token inside NestJS and plain callable function for `src/database/data-source.ts` (TypeORM CLI) _(from phase 01)_
- All new environment variables must be added to the Joi schema in `src/config/env.validation.ts` and documented in `.env.example` _(from phase 01)_
- No direct `process.env` access anywhere in application code — always through config factories or `ConfigService` _(from phase 01)_
- Migration CLI convention: `npm run migration:generate -- src/database/migrations/<Name>`, `migration:run`, `migration:revert`, all pointing at `-d src/database/data-source.ts` _(from phase 01)_
- Seed runner convention: `src/database/seeds/seed.ts`, invoked via `npm run seed` _(from phase 01)_
- `DomainException` abstract base class (`src/common/exceptions/domain.exception.ts`) with `errorCode: string` and `httpStatus: number` fields; concrete subclasses per domain error (e.g., `EmailAlreadyExistsException`) _(from phase 02)_
- Global `@Catch(DomainException)` filter mapping to `{ statusCode, error, message }`; separate `@Catch(BadRequestException)` filter normalizes class-validator errors to `{ statusCode: 400, error: 'VALIDATION_ERROR', message: [...] }` _(from phase 02)_
- Global `ValidationPipe` with `whitelist: true`, `forbidNonWhitelisted: true`, `transform: true` _(from phase 02)_
- Module structure: entity + service + module per bounded concern, extracted into its own module when it grows a distinct lifecycle (e.g., `ChannelsModule` was extracted out of `UsersModule`) — service owns its own `DataSource`/transaction, no `EntityManager` passed in from a caller; pre-check-then-insert with retry-on-unique-violation instead of savepoints _(from phase 02)_
- Services needing atomicity inject `DataSource` directly and use `dataSource.transaction()` internally — never receive a manager from a caller; caller compensates (manual cleanup) on failure instead of wrapping an outer transaction _(from phase 02)_
- Testing convention: unit spec (`*.spec.ts`) + integration spec (`*.integration-spec.ts`) + E2E coverage in `test/*.e2e-spec.ts` for each feature; module compile test (`*.module.spec.ts`) for every new module _(from phase 02)_
- `JwtAuthGuard` registered globally via `APP_GUARD`; endpoints are protected by default, opt out via `@Public()` decorator; `@CurrentUser()` param decorator extracts `request.user` _(from phase 02)_
- TypeScript strictness: use `import type` for interfaces/types referenced only in decorated signatures (avoids TS1272 with `emitDecoratorMetadata`) _(from phase 02)_
- `.hbs` (and similar non-`.ts` asset) files must be registered in `nest-cli.json` `compilerOptions.assets` to be copied to `dist/` on build _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---|---|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache, **queue**) | Unit: real lib with test config |
| Service with side-effect dep (email, **storage**) | Integration: real capture service or local adapter — for this phase, the real MinIO container via Compose, not a mock |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard | E2E + Unit if complex internal logic |
| Exception Filter | Unit + E2E (new domain exceptions for video/upload/processing errors extend the existing `DomainException` pattern) |

Additional note for this phase specifically: `references/external-systems.md` and `references/mock-health-rules.md` (both part of `testing-guide-nestjs-project`) should be consulted when writing tests for the storage adapter, the BullMQ queue producer, and the video worker — the guide's anti-pattern list explicitly calls out "mock configured libs" and favors real instances (real MinIO container, real Redis/BullMQ queue) over mocks wherever Compose can provide them.
