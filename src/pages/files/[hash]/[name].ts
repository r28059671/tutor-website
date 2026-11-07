import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getObject, getPublicObject } from '../../../lib/storage';

// Streams a PDF from B2. Keys are content-addressed, so responses are immutable.
// Only files attached to a published lesson in a live subject/chapter are served publicly.
export const GET: APIRoute = async ({ params, url, locals }) => {
  const key = `files/${params.hash}/${params.name}`;

  const row = await env.DB.prepare(
    `SELECT f.original_name AS originalName,
       (l.status = 'published' AND s.archived_at IS NULL AND c.archived_at IS NULL) AS isPublic
     FROM lesson_files f
     JOIN lessons l ON l.id = f.lesson_id
     JOIN subjects s ON s.id = l.subject_id
     JOIN chapters c ON c.id = l.chapter_id
     WHERE f.r2_key = ?
     ORDER BY isPublic DESC
     LIMIT 1`,
  )
    .bind(key)
    .first<{ originalName: string; isPublic: number }>();

  const isAdmin = (locals as { isAdmin?: boolean }).isAdmin;
  if (!row || (!row.isPublic && !isAdmin)) {
    return new Response('This file isn’t available.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  // Drafts skip the edge cache. Public copies stay guarded by the check above, so a deleted file still 404s.
  let object: Response | null;
  try {
    object = row.isPublic ? await getPublicObject(key, url.origin, locals.cfContext) : await getObject(key);
  } catch (err) {
    console.error('File read failed', key, err);
    return new Response('This file can’t be opened right now. Please try again later.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '3600' },
    });
  }
  if (!object) {
    return new Response('This file is missing. Please let your tutor know.', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const filename = row.originalName.replace(/[\r\n"]/g, '') || 'notes.pdf';
  const disposition = url.searchParams.has('download') ? 'attachment' : 'inline';
  const asciiName = filename.replace(/[^\x20-\x7e]/g, '_');

  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': row.isPublic ? 'public, max-age=31536000, immutable' : 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const name of ['Content-Length', 'ETag']) {
    const value = object.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(object.body, { headers });
};
