---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-09-14T13:27:02.019242700-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-14T13:25:09.360231400-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver video upload of up to 10GB without blocking the API (via presigned multipart upload directly to storage), automatic background processing (metadata/duration extraction and thumbnail generation via a BullMQ-driven video worker), a unique short URL per video, and streaming/download via direct storage access — with the video status lifecycle (draft → processing → ready/failed) tracked in PostgreSQL.

---

## Step Implementations

### SI-03.1 — Infra: object storage, fila e worker no Compose

**Description:** Adicionar os serviços de infraestrutura novos da fase (MinIO como object storage S3-compatible, Redis para a fila BullMQ, e um container do video worker) ao `compose.yaml`, subindo junto com a stack existente.

**Technical actions:**

1. Adicionar serviço `minio` ao `compose.yaml` — imagem `minio/minio`, portas API + console, volume persistente, healthcheck (per `upload-processing/TD-02`).
2. Adicionar serviço `redis` ao `compose.yaml` — imagem `redis`, porta padrão, healthcheck (per `upload-processing/TD-01`).
3. Adicionar serviço `video-worker` ao `compose.yaml` — build a partir do mesmo `Dockerfile.dev` da API, comando de start diferente (`node dist/worker.js` ou equivalente em dev), instalando FFmpeg na imagem (per `upload-processing/TD-03`).
4. Atualizar `.env.example` e `env.validation.ts` com as novas variáveis (`MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `REDIS_HOST`, `REDIS_PORT`) seguindo a convenção de `registerAs` já usada pelo projeto (per `phase-01-configuracao-base/TD-01`, `phase-01-configuracao-base/TD-03`).

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` sobe `minio`, `redis` e `video-worker` com status saudável junto com `nestjs-api`, `db` e `mailpit`.
- As novas variáveis de ambiente estão documentadas em `.env.example` e validadas pelo schema Joi.
- `video-worker` tem o binário FFmpeg disponível (`ffmpeg -version` executa com sucesso dentro do container).

---

### SI-03.2 — Migration + entidade Video

**Description:** Criar a tabela `videos` via migration TypeORM e a entidade `Video` correspondente, ligada ao `Channel` via `channel_id`.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` — `Video` com todos os campos do Data Model (`id`, `channel_id`, `slug`, `title`, `status`, `storage_key`, `thumbnail_key`, `duration_seconds`, `video_codec`, `width`, `height`, `file_size_bytes`, `mime_type`, `failure_reason`, `upload_id`, `created_at`, `updated_at`) seguindo as convenções de `nestjs-entities` (`@Entity('videos')`, `@PrimaryGeneratedColumn('uuid')`, `@CreateDateColumn`/`@UpdateDateColumn`) (per `upload-processing/TD-04`, `upload-processing/TD-05`).
2. Adicionar `@ManyToOne(() => Channel)` + `@JoinColumn({ name: 'channel_id' })` em `Video`, e o lado inverso `@OneToMany(() => Video, ...)` em `Channel`.
3. Gerar a migration `<timestamp>-CreateVideos.ts` via `npm run migration:generate -- src/database/migrations/CreateVideos` seguindo a convenção já estabelecida (per `phase-01-configuracao-base/TD-01`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, unique `slug`, `select: false` onde aplicável | `src/videos/entities/video.entity.integration-spec.ts` |
| Migration `CreateVideos` | Integration: aplica e reverte corretamente, cria a tabela `videos` com todas as colunas | `src/database/migrations.integration-spec.ts` (extensão do teste existente) |

**Dependencies:** SI-03.1 (a infra precisa estar de pé para os testes de integração rodarem contra o banco real)

**Acceptance criteria:**

- A migration `CreateVideos` cria a tabela `videos` com todas as colunas do Data Model, FK para `channels`, e índice único em `slug`.
- Reverter a migration remove a tabela `videos` sem afetar `channels`/`users`.
- A entidade `Video` mapeia corretamente todos os campos e a relação com `Channel`.

---

### SI-03.3 — VideosModule + StorageService (presigned multipart)

**Description:** Criar o módulo `VideosModule` e o `StorageService`, responsável por encapsular a comunicação com o object storage (MinIO/S3) via presigned multipart upload.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` + `src/storage/storage.service.ts` — `StorageService` com métodos `createMultipartUpload`, `getPartUploadUrls`, `completeMultipartUpload`, `getPresignedGetUrl` (per `upload-processing/TD-02`, `upload-processing/TD-06`).
2. Criar `src/videos/videos.module.ts` — registra `TypeOrmModule.forFeature([Video])`, importa `StorageModule`, declara `VideosService` e `VideosController` (seguindo a convenção de módulos existente, per `phase-02-auth/TD-07` convention notes em `## Inherited Conventions`).
3. Criar `src/videos/videos.service.ts` com o método `createDraft(channelId, title, fileSizeBytes, mimeType)` — pré-cadastra o vídeo como `draft`, gera o `slug` com o padrão de retry-on-collision de `ChannelsService`, inicia o multipart upload via `StorageService` (per `upload-processing/TD-04`, `upload-processing/TD-05`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Unit: mocka o cliente S3, testa a montagem correta dos comandos de multipart | `src/storage/storage.service.spec.ts` |
| `VideosService.createDraft` | Unit: branch logic (mock repo + mock StorageService) | `src/videos/videos.service.spec.ts` |
| `VideosService.createDraft` | Integration: persistência real do rascunho + retry de colisão de slug | `src/videos/videos.service.integration-spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.2 (entidade `Video` precisa existir)

**Acceptance criteria:**

- `VideosService.createDraft` persiste um `Video` com `status: 'draft'` e um `slug` único antes de qualquer byte do arquivo ser enviado.
- Uma colisão de `slug` é resolvida por retry, sem expor erro ao chamador.
- `StorageService.createMultipartUpload` retorna um `upload_id` e URLs presignadas por parte.

---

### SI-03.4 — Endpoints de upload: POST /videos e POST /videos/{id}/complete-upload

**Description:** Expor os endpoints HTTP que o cliente usa para iniciar o upload (pré-cadastro do rascunho + URLs presignadas) e concluí-lo (o que dispara a transição de status e o enfileiramento do job).

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` (`title`, `file_size_bytes`, `mime_type`) e `src/videos/dto/complete-upload.dto.ts` (`parts: { part_number, etag }[]`) com `class-validator` (per `phase-02-auth/TD-06`).
2. Adicionar `POST /videos` em `VideosController`, delegando a `VideosService.createDraft` (per `### API Contracts`).
3. Adicionar `POST /videos/:id/complete-upload` em `VideosController`, delegando a um novo método `VideosService.completeUpload(id, parts, userId)` que verifica ownership, chama `StorageService.completeMultipartUpload`, transiciona `status` para `processing` e enfileira o job (per `upload-processing/TD-04` Note, `### API Contracts`).
4. Lançar `VideoNotFoundException`, `ForbiddenException` (ownership) e `VideoAlreadyProcessedException` conforme `### Error Catalog`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `POST /videos` | E2E: sucesso, 401 sem token, 400 payload inválido | `test/videos.e2e-spec.ts` |
| `POST /videos/:id/complete-upload` | E2E: sucesso, 403 não-owner, 404 vídeo inexistente, 409 já processado | `test/videos.e2e-spec.ts` |
| DTOs | E2E: uma verificação de wiring do ValidationPipe por endpoint | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.3

**Acceptance criteria:**

- `POST /videos` com payload válido retorna `201` com `id`, `slug`, `status: 'draft'`, `upload_id` e `part_urls`.
- `POST /videos/:id/complete-upload` com parts válidas retorna `200` com `status: 'processing'`.
- `POST /videos/:id/complete-upload` para um vídeo de outro canal retorna `403`.
- `POST /videos/:id/complete-upload` chamado duas vezes retorna `409 VIDEO_ALREADY_PROCESSED` na segunda chamada.

---

### SI-03.5 — Fila BullMQ: módulo + producer

**Description:** Configurar o `@nestjs/bullmq` com Redis e implementar o producer que enfileira o job `video.process` no mesmo handler que completa o multipart upload.

**Technical actions:**

1. Instalar `@nestjs/bullmq` + `bullmq`; criar `src/queue/queue.module.ts` registrando `BullModule.forRootAsync` com config de Redis via `registerAs` (`queue.config.ts`), seguindo a convenção de config namespaced (per `upload-processing/TD-01`, `phase-01-configuracao-base/TD-03`).
2. Registrar a fila `video-processing` via `BullModule.registerQueue` dentro de `VideosModule`.
3. Injetar a `Queue` em `VideosService.completeUpload` para enfileirar o job `video.process` com payload `{ videoId, storageKey }` (per `### Events/Messages`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilation test | `src/queue/queue.module.spec.ts` |
| `VideosService.completeUpload` | Integration: job real é enfileirado na fila `video-processing` (fila real via Compose, não mock) | `src/videos/videos.service.integration-spec.ts` (extensão) |

**Dependencies:** SI-03.4 (o método `completeUpload` já precisa existir)

**Acceptance criteria:**

- Ao completar o upload, um job `video.process` com o payload correto aparece na fila `video-processing` (verificável via BullMQ real contra o Redis do Compose).
- A transição de status para `processing` e o enfileiramento do job ocorrem na mesma chamada (per `upload-processing/TD-04` Note).

---

### SI-03.6 — Video worker: consumer BullMQ + processamento FFmpeg

**Description:** Implementar o segundo entry point (`src/worker.ts`) que consome o job `video.process`, extrai metadados via ffprobe, gera a thumbnail via FFmpeg, faz upload do resultado ao storage e atualiza o status do vídeo.

**Technical actions:**

1. Criar `src/worker.ts` — bootstrap NestJS standalone (`NestFactory.createApplicationContext`) que carrega apenas os módulos necessários (`VideosModule`, `StorageModule`, `QueueModule`, `TypeOrmModule`), sem HTTP listener (per `upload-processing/TD-03`).
2. Instalar `fluent-ffmpeg` + `ffmpeg-static`; criar `src/videos/video-processor.service.ts` com um método `process(videoId)` que baixa/lê o arquivo do storage, roda ffprobe para extrair `duration_seconds`, `video_codec`, `width`, `height`, `file_size_bytes`, `mime_type`, e gera um frame de thumbnail (per `upload-processing/TD-03` Note).
3. Criar `src/videos/video.processor.ts` — um BullMQ `WorkerHost` que consome a fila `video-processing`, chama `VideoProcessorService.process`, e em caso de sucesso faz upload da thumbnail via `StorageService` e atualiza `Video` para `status: 'ready'` com os campos extraídos; em caso de exceção, atualiza para `status: 'failed'` com `failure_reason` (per `upload-processing/TD-04`).
4. Adicionar script `worker:start:dev` ao `package.json` e comando correspondente no serviço `video-worker` do Compose (referência cruzada com `SI-03.1`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessorService.process` | Integration: roda ffprobe/FFmpeg reais contra um arquivo de vídeo de teste, valida os campos extraídos | `src/videos/video-processor.service.integration-spec.ts` |
| `VideoProcessor` (WorkerHost) | Integration: consome um job real da fila, atualiza o `Video` para `ready` no banco real | `src/videos/video.processor.integration-spec.ts` |
| `VideoProcessor` (WorkerHost) — falha | Integration: job com arquivo corrompido resulta em `status: 'failed'` + `failure_reason` preenchido | `src/videos/video.processor.integration-spec.ts` (mesmo arquivo) |

**Dependencies:** SI-03.5 (fila precisa estar publicando jobs)

**Acceptance criteria:**

- Um job `video.process` bem-sucedido atualiza o `Video` para `status: 'ready'`, preenchendo `duration_seconds`, `video_codec`, `width`, `height`, `file_size_bytes`, `mime_type` e `thumbnail_key`.
- Um job cujo arquivo de origem está corrompido ou tem codec não suportado atualiza o `Video` para `status: 'failed'` com `failure_reason` não nulo.
- O worker roda como processo separado da API (`node dist/worker.js` não inicia um listener HTTP).

---

### SI-03.7 — Endpoints de streaming, download e leitura por slug

**Description:** Expor os endpoints que permitem assistir (streaming via Range requests), baixar e consultar metadados de um vídeo pronto, todos delegando ao storage via URL presignada/direta em vez de servir os bytes pela API.

**Technical actions:**

1. Adicionar `GET /videos/:id/stream` em `VideosController`, retornando um redirect `302` para uma URL presignada de GET gerada por `StorageService.getPresignedGetUrl` (per `upload-processing/TD-06`, `### API Contracts`).
2. Adicionar `GET /videos/:id/download`, análogo ao anterior, com `Content-Disposition: attachment` (per `### API Contracts`).
3. Adicionar `GET /videos/:slug` em `VideosController` (endpoint público, sem guard), retornando os metadados do vídeo e a `thumbnail_url` presignada quando `status: 'ready'` (per `### API Contracts`).
4. Lançar `VideoNotReadyException` conforme `### Error Catalog` quando o status não é `ready` nos endpoints de stream/download.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `GET /videos/:id/stream` | E2E: 302 para vídeo pronto, 409 para vídeo não pronto, 404 para inexistente | `test/videos.e2e-spec.ts` |
| `GET /videos/:id/download` | E2E: 302 para vídeo pronto, 409/404 conforme acima | `test/videos.e2e-spec.ts` |
| `GET /videos/:slug` | E2E: 200 com metadados, 404 para slug inexistente, acessível sem autenticação | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.6 (vídeos precisam poder chegar a `ready` para os testes de sucesso)

**Acceptance criteria:**

- `GET /videos/:id/stream` para um vídeo `ready` retorna `302` para uma URL de storage que responde `206 Partial Content` a uma requisição com header `Range`.
- `GET /videos/:id/download` para um vídeo `ready` retorna `302` para uma URL com `Content-Disposition: attachment`.
- `GET /videos/:slug` é acessível sem token de autenticação (usuário anônimo).
- Ambos os endpoints de stream/download retornam `409 VIDEO_NOT_READY` para vídeos em `draft`, `processing` ou `failed`.

---

### SI-03.8 — Domain exceptions de vídeo

**Description:** Adicionar as novas exceções de domínio da fase (`VideoNotFoundException`, `VideoAlreadyProcessedException`, `VideoNotReadyException`) estendendo `DomainException`, reaproveitando o filtro global já existente.

**Technical actions:**

1. Adicionar `VideoNotFoundException`, `VideoAlreadyProcessedException`, `VideoNotReadyException` em `src/common/exceptions/domain.exception.ts` (ou um arquivo de exceções dedicado ao módulo `videos`, seguindo o padrão de `EmailAlreadyExistsException` etc.), cada uma com seu `errorCode`/`httpStatus`/`message` conforme `### Error Catalog` (per `phase-02-auth/TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Novas exceções | Unit + E2E: filtro global mapeia corretamente cada exceção para `{ statusCode, error, message }` | `src/videos/videos.exceptions.spec.ts` + cobertura via `test/videos.e2e-spec.ts` (já emitida nos SIs anteriores) |

**Dependencies:** none (pode ser feito em paralelo com SI-03.2 em diante; listado por último por ser transversal)

**Acceptance criteria:**

- Cada nova exceção de domínio é capturada pelo `DomainExceptionFilter` global existente e produz a resposta `{ statusCode, error, message }` com o `errorCode` correto.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| channel_id | uuid | FK → channels.id, not null |
| slug | varchar(10) | unique, not null — short generated URL identifier (per upload-processing/TD-05) |
| title | varchar(255) | not null |
| status | enum('draft', 'processing', 'ready', 'failed') | not null, default 'draft' (per upload-processing/TD-04) |
| storage_key | varchar(512) | not null — object storage key for the video file |
| thumbnail_key | varchar(512) | nullable — object storage key for the generated thumbnail (populated on processing success) |
| duration_seconds | integer | nullable — populated by the worker on processing success |
| video_codec | varchar(50) | nullable — populated by the worker on processing success (per upload-processing/TD-03 Note) |
| width | integer | nullable — populated by the worker on processing success (per upload-processing/TD-03 Note) |
| height | integer | nullable — populated by the worker on processing success (per upload-processing/TD-03 Note) |
| file_size_bytes | bigint | nullable — populated by the worker on processing success (per upload-processing/TD-03 Note) |
| mime_type | varchar(100) | nullable — populated by the worker on processing success (per upload-processing/TD-03 Note) |
| failure_reason | text | nullable — populated on processing failure (per upload-processing/TD-04) |
| upload_id | varchar(255) | nullable — storage's multipart upload identifier, retained until completion (per upload-processing/TD-02) |
| created_at | timestamptz | default now() |
| updated_at | timestamptz | default now() |

**Relations:** `Channel` has many `Video` (one-to-many); `Video.channel_id` → `Channel.id`
**Indexes:** unique on `slug`; index on `channel_id`; index on `status`

### API Contracts

#### POST /videos (SI-03.X)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- title: string, required — video title
- file_size_bytes: number, required — total size of the file to upload, used to plan multipart parts (per upload-processing/TD-02)
- mime_type: string, required

**Response 201:**
- id: string (uuid)
- slug: string — the unique short URL identifier (per upload-processing/TD-05)
- status: string — 'draft'
- upload_id: string — storage's multipart upload identifier
- part_urls: array of { part_number: number, url: string } — presigned PUT URLs, one per part (per upload-processing/TD-02)

**Error responses:**
- 401 UNAUTHORIZED: when no valid access token is provided
- 400 validation error: when the request body fails schema validation

---

#### POST /videos/{id}/complete-upload (SI-03.X)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- parts: array of { part_number: number, etag: string }, required — the ETags collected from each part's presigned PUT response (per upload-processing/TD-02)

**Response 200:**
- id: string (uuid)
- status: string — 'processing'

**Error responses:**
- 401 UNAUTHORIZED: when no valid access token is provided
- 403 FORBIDDEN: when the video's channel does not belong to the authenticated user
- 404 VIDEO_NOT_FOUND: when the video id does not exist
- 409 VIDEO_ALREADY_PROCESSED: when the video is not in `draft` status
- 400 validation error: when the request body fails schema validation

---

#### GET /videos/{id}/stream (SI-03.X)

**Request headers:**
- Range: bytes={start}-{end} — optional, per HTTP range request semantics (per upload-processing/TD-06)

**Response 302:** redirects to a presigned/direct GET URL pointing at the video object in storage, which natively serves the `Range` request and responds `206 Partial Content` (per upload-processing/TD-06)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video id does not exist
- 409 VIDEO_NOT_READY: when the video's status is not `ready`

---

#### GET /videos/{id}/download (SI-03.X)

**Response 302:** redirects to a presigned/direct GET URL pointing at the video object in storage, with a `Content-Disposition: attachment` hint for download (per upload-processing/TD-06)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when the video id does not exist
- 409 VIDEO_NOT_READY: when the video's status is not `ready`

---

#### GET /videos/{slug} (SI-03.X)

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: string
- duration_seconds: number | null
- thumbnail_url: string | null — presigned/direct GET URL for the thumbnail, when status is `ready`

**Error responses:**
- 404 VIDEO_NOT_FOUND: when no video matches the slug

---

#### Validation Rules — Backend

- `title`: required, non-empty string, max 255 characters
- `file_size_bytes`: required, positive integer, max 10737418240 (10GB) — enforced per upload-processing/TD-02's 10GB cap
- `mime_type`: required, must match an accepted video MIME type
- `parts`: required non-empty array; each entry requires `part_number` (positive integer) and `etag` (non-empty string)

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner (video's channel) |
|----------|-----------|---------------|--------------------------|
| POST /videos | ✗ | ✓ | ✓ (creates own video) |
| POST /videos/{id}/complete-upload | ✗ | ✓ | ✓ (only owner may complete) |
| GET /videos/{id}/stream | ✓ | ✓ | ✓ |
| GET /videos/{id}/download | ✓ | ✓ | ✓ |
| GET /videos/{slug} | ✓ | ✓ | ✓ |

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | Requisição referenciando um vídeo (id ou slug) inexistente |
| VIDEO_ALREADY_PROCESSED | 409 | Chamada a complete-upload para um vídeo que não está em status `draft` |
| VIDEO_NOT_READY | 409 | Streaming ou download solicitado para um vídeo cujo status não é `ready` |
| VIDEO_PROCESSING_FAILED | 500 | Status interno registrado pelo worker quando ffprobe/FFmpeg falha (arquivo corrompido, codec não suportado); refletido em `Video.status = 'failed'` + `Video.failure_reason`, não retornado como resposta HTTP direta |

Error response shape inherited from `phase-02-auth/TD-07` (`{ statusCode, error, message }`); new domain exceptions above extend the existing `DomainException` base class.

### Events/Messages

#### video.process

**Payload:**

```json
{ "videoId": "uuid", "storageKey": "string" }
```

**Producer:** `VideosService` (per `upload-processing/TD-01`, `upload-processing/TD-04`)
**Consumer:** Video Worker's BullMQ `WorkerHost` processor (per `upload-processing/TD-03`)
**Trigger:** enqueued synchronously inside the same request handler that completes the multipart upload — `POST /videos/{id}/complete-upload` calls storage's `CompleteMultipartUpload`, then atomically transitions the video's status to `processing` and enqueues this job (per `upload-processing/TD-04` Note)
**Delivery semantics:** at-least-once, with BullMQ's built-in job retry/backoff on transient failures; exhausted retries transition the video to `failed` with a recorded `failure_reason` (per `upload-processing/TD-01`, `upload-processing/TD-04`)

---

<!-- phase-a-complete -->

## Dependency Map

```
SI-03.1 (root — infra: storage, fila, worker no Compose)
└── SI-03.2 — depends on SI-03.1 (migration/entidade precisa da infra para testes de integração)
    └── SI-03.3 — depends on SI-03.2 (VideosModule/StorageService precisam da entidade Video)
        └── SI-03.4 — depends on SI-03.3 (endpoints de upload precisam do VideosService)
            └── SI-03.5 — depends on SI-03.4 (producer precisa do método completeUpload)
                └── SI-03.6 — depends on SI-03.5 (worker consome jobs publicados pelo producer)
                    └── SI-03.7 — depends on SI-03.6 (endpoints de stream/download testam vídeos em status ready)
SI-03.8 (root, independente — exceções de domínio transversais)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: object storage, fila e worker no Compose
- [ ] SI-03.2 — Migration + entidade Video
- [ ] SI-03.3 — VideosModule + StorageService (presigned multipart)
- [ ] SI-03.4 — Endpoints de upload: POST /videos e POST /videos/{id}/complete-upload
- [ ] SI-03.5 — Fila BullMQ: módulo + producer
- [ ] SI-03.6 — Video worker: consumer BullMQ + processamento FFmpeg
- [ ] SI-03.7 — Endpoints de streaming, download e leitura por slug
- [ ] SI-03.8 — Domain exceptions de vídeo

**Full test suites:**

- [ ] Unit + integration tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
