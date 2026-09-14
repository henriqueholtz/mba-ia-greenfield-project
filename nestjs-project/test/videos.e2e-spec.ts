import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let userCounter = 0;
  async function registerConfirmAndLogin(): Promise<{
    accessToken: string;
    email: string;
  }> {
    userCounter += 1;
    const email = `videos_e2e_${userCounter}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });

    return { accessToken: loginRes.body.access_token, email };
  }

  async function createDraftVideo(
    accessToken: string,
  ): Promise<{ id: string; partUrl: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Video to complete',
        file_size_bytes: 1024,
        mime_type: 'video/mp4',
      });
    return { id: res.body.id, partUrl: res.body.part_urls[0].url };
  }

  async function uploadPartAndGetEtag(partUrl: string): Promise<string> {
    const url = new URL(partUrl);
    const res = await fetch(partUrl, {
      method: 'PUT',
      body: Buffer.from('fake video bytes'),
    });
    if (!res.ok) {
      throw new Error(
        `Failed to upload part to ${url.pathname}: ${res.status}`,
      );
    }
    const etag = res.headers.get('etag');
    if (!etag) {
      throw new Error('Storage did not return an ETag header');
    }
    return etag;
  }

  describe('POST /videos', () => {
    it('returns 201 with id, slug, status draft, upload_id and part_urls', async () => {
      const { accessToken } = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          title: 'My video',
          file_size_bytes: 1024,
          mime_type: 'video/mp4',
        })
        .expect(201);

      expect(res.body.id).toBeDefined();
      expect(res.body.slug).toBeDefined();
      expect(res.body.status).toBe('draft');
      expect(res.body.upload_id).toBeDefined();
      expect(Array.isArray(res.body.part_urls)).toBe(true);
      expect(res.body.part_urls.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 401 without an Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          title: 'My video',
          file_size_bytes: 1024,
          mime_type: 'video/mp4',
        })
        .expect(401);
    });

    it('returns 400 with invalid payload (missing title)', async () => {
      const { accessToken } = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ file_size_bytes: 1024, mime_type: 'video/mp4' })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /videos/:id/complete-upload', () => {
    it('returns 200 with status processing when parts were really uploaded to storage', async () => {
      const { accessToken } = await registerConfirmAndLogin();
      const { id: videoId, partUrl } = await createDraftVideo(accessToken);
      const etag = await uploadPartAndGetEtag(partUrl);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);

      expect(res.body.id).toBe(videoId);
      expect(res.body.status).toBe('processing');
    });

    it('returns 403 when the video belongs to a different channel', async () => {
      const owner = await registerConfirmAndLogin();
      const other = await registerConfirmAndLogin();
      const { id: videoId, partUrl } = await createDraftVideo(
        owner.accessToken,
      );
      const etag = await uploadPartAndGetEtag(partUrl);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${other.accessToken}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(403);

      expect(res.body.error).toBe('VIDEO_FORBIDDEN');
    });

    it('returns 404 for a non-existent video', async () => {
      const { accessToken } = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete-upload')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: 1, etag: '"etag-1"' }] })
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });

    it('returns 409 VIDEO_ALREADY_PROCESSED when called twice', async () => {
      const { accessToken } = await registerConfirmAndLogin();
      const { id: videoId, partUrl } = await createDraftVideo(accessToken);
      const etag = await uploadPartAndGetEtag(partUrl);

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(200);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(409);

      expect(res.body.error).toBe('VIDEO_ALREADY_PROCESSED');
    });

    it('returns 400 with invalid payload (empty parts array)', async () => {
      const { accessToken } = await registerConfirmAndLogin();
      const { id: videoId } = await createDraftVideo(accessToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [] })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });

    it('returns 401 without an Authorization header', async () => {
      const { accessToken } = await registerConfirmAndLogin();
      const { id: videoId } = await createDraftVideo(accessToken);

      await request(app.getHttpServer())
        .post(`/videos/${videoId}/complete-upload`)
        .send({ parts: [{ part_number: 1, etag: '"etag-1"' }] })
        .expect(401);
    });
  });
});
