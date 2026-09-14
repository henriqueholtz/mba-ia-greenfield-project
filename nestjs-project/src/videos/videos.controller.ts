import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { Public } from '../auth/decorators/public.decorator';
import { ChannelsService } from '../channels/channels.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideosService } from './videos.service';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
  ) {}

  @Post()
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Pre-registers a video draft and initiates a presigned multipart upload.',
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created and multipart upload initiated',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        status: { type: 'string', example: 'draft' },
        upload_id: { type: 'string' },
        part_urls: {
          type: 'array',
          items: {
            properties: {
              part_number: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async create(
    @Body() dto: CreateVideoDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<{
    id: string;
    slug: string;
    status: string;
    upload_id: string;
    part_urls: { part_number: number; url: string }[];
  }> {
    const channel = await this.channelsService.findByUserId(user.sub);
    if (!channel) {
      throw new Error(`No channel found for user ${user.sub}`);
    }

    const { video, uploadId, partUrls } = await this.videosService.createDraft(
      channel.id,
      dto.title,
      dto.file_size_bytes,
      dto.mime_type,
    );

    return {
      id: video.id,
      slug: video.slug,
      status: video.status,
      upload_id: uploadId,
      part_urls: partUrls.map((p) => ({
        part_number: p.partNumber,
        url: p.url,
      })),
    };
  }

  @Post(':id/complete-upload')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload and transitions the video to processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed, video is now processing',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', example: 'processing' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 403,
    description: "Video does not belong to the authenticated user's channel",
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video upload has already been completed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @Param('id') id: string,
    @Body() dto: CompleteUploadDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<{ id: string; status: string }> {
    const video = await this.videosService.completeUpload(
      id,
      dto.parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })),
      user.sub,
    );

    return { id: video.id, status: video.status };
  }

  @Get(':id/stream')
  @Public()
  @ApiOperation({
    summary: 'Stream a video',
    description:
      'Redirects to a presigned storage URL that natively serves Range requests.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned storage URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async stream(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.getStreamUrl(id);
    res.redirect(HttpStatus.FOUND, url);
  }

  @Get(':id/download')
  @Public()
  @ApiOperation({
    summary: 'Download a video',
    description:
      'Redirects to a presigned storage URL with a Content-Disposition attachment hint.',
  })
  @ApiResponse({
    status: 302,
    description: 'Redirect to a presigned storage URL',
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video is not ready for playback',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async download(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.videosService.getDownloadUrl(id);
    res.redirect(HttpStatus.FOUND, url);
  }

  @Get(':slug')
  @Public()
  @ApiOperation({
    summary: 'Get video metadata by slug',
    description:
      'Returns public video metadata, including a presigned thumbnail URL when ready.',
  })
  @ApiResponse({
    status: 200,
    description: 'Video metadata',
    schema: {
      properties: {
        id: { type: 'string', format: 'uuid' },
        slug: { type: 'string' },
        title: { type: 'string' },
        status: { type: 'string' },
        duration_seconds: { type: 'number', nullable: true },
        thumbnail_url: { type: 'string', nullable: true },
      },
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async findBySlug(@Param('slug') slug: string): Promise<{
    id: string;
    slug: string;
    title: string;
    status: string;
    duration_seconds: number | null;
    thumbnail_url: string | null;
  }> {
    const video = await this.videosService.findBySlug(slug);

    const thumbnailUrl =
      video.status === 'ready' && video.thumbnail_key
        ? await this.videosService.getThumbnailUrl(video.thumbnail_key)
        : null;

    return {
      id: video.id,
      slug: video.slug,
      title: video.title,
      status: video.status,
      duration_seconds: video.duration_seconds,
      thumbnail_url: thumbnailUrl,
    };
  }
}
