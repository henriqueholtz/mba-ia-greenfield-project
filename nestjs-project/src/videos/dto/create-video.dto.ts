import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  Max,
  MaxLength,
} from 'class-validator';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
const ACCEPTED_VIDEO_MIME_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
];

export class CreateVideoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsInt()
  @IsPositive()
  @Max(MAX_FILE_SIZE_BYTES)
  file_size_bytes: number;

  @IsString()
  @IsIn(ACCEPTED_VIDEO_MIME_TYPES)
  mime_type: string;
}
