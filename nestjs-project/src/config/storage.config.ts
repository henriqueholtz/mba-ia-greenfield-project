import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.MINIO_ENDPOINT || 'http://minio:9000',
  accessKeyId: process.env.MINIO_ACCESS_KEY || '',
  secretAccessKey: process.env.MINIO_SECRET_KEY || '',
  bucket: process.env.MINIO_BUCKET || 'streamtube-videos',
}));
