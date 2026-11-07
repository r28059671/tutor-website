import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { getPublicObject } from '../../lib/storage';

// Serves the tutor's photo. Only the key currently on the profile is public.
export const GET: APIRoute = async ({ params, url, locals }) => {
  const key = `media/${params.name}`;
  const row = await env.DB.prepare('SELECT photo_key AS key FROM tutor_profile WHERE id = 1').first<{ key: string | null }>();
  if (!row?.key || row.key !== key) return new Response('Not found', { status: 404 });

  let object: Response | null;
  try {
    object = await getPublicObject(key, url.origin, locals.cfContext);
  } catch (err) {
    console.error('Photo read failed', key, err);
    return new Response('Temporarily unavailable', { status: 503, headers: { 'Retry-After': '3600' } });
  }
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers({
    'Content-Type': object.headers.get('Content-Type') ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  const etag = object.headers.get('ETag');
  if (etag) headers.set('ETag', etag);
  return new Response(object.body, { headers });
};
