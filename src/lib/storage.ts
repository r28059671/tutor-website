// Object storage on Backblaze B2, through its S3-compatible API.
// B2 has no Worker binding, so every call is a signed HTTPS request. The bucket stays private.
import { AwsClient } from 'aws4fetch';
import { env } from 'cloudflare:workers';

function b2() {
  return new AwsClient({
    accessKeyId: env.B2_KEY_ID,
    secretAccessKey: env.B2_APP_KEY,
    service: 's3',
    region: env.B2_REGION,
    // The aws4fetch default of 10 can leave a student waiting on a failing request.
    retries: 2,
  });
}

function objectUrl(key: string) {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `https://${env.B2_ENDPOINT}/${env.B2_BUCKET}/${path}`;
}

async function failure(action: string, key: string, res: Response) {
  return new Error(`B2 ${action} failed for ${key}: ${res.status} ${await res.text()}`);
}

/** Null when the object doesn't exist. Throws on anything else, including B2 cap errors. */
export async function getObject(key: string): Promise<Response | null> {
  const res = await b2().fetch(objectUrl(key));
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  if (!res.ok) throw await failure('GET', key, res);
  return res;
}

/**
 * Same as getObject, with a copy kept in the Cloudflare edge cache so repeat downloads skip B2.
 * Call it only for content already confirmed public. Cached entries are keyed by object key, so
 * inline and ?download=1 requests share one. The Cache API is only documented on custom domains,
 * so on workers.dev this may simply miss every time.
 */
export async function getPublicObject(key: string, origin: string, ctx: Pick<ExecutionContext, 'waitUntil'>): Promise<Response | null> {
  const cache = caches.default;
  const cacheKey = new Request(`${origin}/${key}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const object = await getObject(key);
  if (!object) return null;

  const headers = new Headers({ 'Cache-Control': 'public, max-age=31536000, immutable' });
  for (const name of ['Content-Type', 'Content-Length', 'ETag']) {
    const value = object.headers.get(name);
    if (value) headers.set(name, value);
  }
  const response = new Response(object.body, { headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()).catch((err) => console.error('Edge cache write failed', key, err)));
  return response;
}

export async function putObject(key: string, data: ArrayBuffer, contentType: string) {
  const res = await b2().fetch(objectUrl(key), { method: 'PUT', body: data, headers: { 'Content-Type': contentType } });
  if (!res.ok) throw await failure('PUT', key, res);
  await res.body?.cancel();
}

/** One request per key, because B2 multi-delete support is unconfirmed. Throws if any delete fails. */
export async function deleteObjects(keys: string[]) {
  const results = await Promise.allSettled(
    keys.map(async (key) => {
      const res = await b2().fetch(objectUrl(key), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw await failure('DELETE', key, res);
      await res.body?.cancel();
    }),
  );
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map((r) => r.reason), 'B2 delete failed');
}
