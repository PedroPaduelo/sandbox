import mime from 'mime-types';

export function detectMime(filePath: string): string {
  return mime.lookup(filePath) || 'application/octet-stream';
}
