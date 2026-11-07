import type { FileKind } from '../db/schema';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SAVE_BYTES = 90 * 1024 * 1024;

export const FILE_KINDS: FileKind[] = ['notes', 'worksheet', 'solutions'];

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function safeFileName(name: string): string {
  const base = name
    .replace(/\.pdf$/i, '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return `${base || 'notes'}.pdf`;
}

/** Content-addressed key: a replaced PDF gets a new URL, so immutable caching stays correct. */
export function fileKey(hash: string, name: string) {
  return `files/${hash.slice(0, 16)}/${safeFileName(name)}`;
}

/** Public URL for a stored file. The route mirrors the object key. */
export function fileUrl(r2Key: string) {
  return `/${r2Key}`;
}

/** PDF magic bytes, since the browser-supplied MIME type is only a hint. */
export function looksLikePdf(data: ArrayBuffer) {
  const head = new Uint8Array(data, 0, Math.min(5, data.byteLength));
  return String.fromCharCode(...head) === '%PDF-';
}

export function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
