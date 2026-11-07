import { defineAction, ActionError } from 'astro:actions';
import { z } from 'astro/zod';
import { eq } from 'drizzle-orm';
import { tutorProfile } from '../db/schema';
import { requireAdmin, sqlNow } from '../lib/admin';
import { getDb } from '../lib/db';
import { sha256Hex } from '../lib/files';
import { deleteObjects, putObject } from '../lib/storage';

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/** Sniff the real image type; the browser-supplied MIME type is only a hint. */
function imageType(data: ArrayBuffer): { ext: string; mime: string } | null {
  const b = new Uint8Array(data, 0, Math.min(12, data.byteLength));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  const ascii = String.fromCharCode(...b);
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

export const profileActions = {
  saveTutorProfile: defineAction({
    accept: 'form',
    input: z.object({
      name: z.string().trim().max(80, 'Keep the name under 80 characters.').nullish(),
      headline: z.string().trim().max(120, 'Keep the headline under 120 characters.').nullish(),
      bio: z.string().trim().max(2000, 'Keep the bio under 2,000 characters.').nullish(),
      photo: z.instanceof(File).nullish(),
      removePhoto: z.coerce.boolean().nullish(),
    }),
    handler: async (input, context) => {
      requireAdmin(context);
      const db = getDb();
      const [current] = await db.select().from(tutorProfile).where(eq(tutorProfile.id, 1));
      let photoKey = current?.photoKey ?? null;
      let previousKey: string | null = null;

      if (input.photo && input.photo.size > 0) {
        if (input.photo.size > MAX_PHOTO_BYTES) {
          throw new ActionError({ code: 'BAD_REQUEST', message: 'The photo is over 2 MB. Choose a smaller image.' });
        }
        const data = await input.photo.arrayBuffer();
        const type = imageType(data);
        if (!type) throw new ActionError({ code: 'BAD_REQUEST', message: 'Use a JPEG, PNG or WebP photo.' });
        const key = `media/tutor-${(await sha256Hex(data)).slice(0, 16)}.${type.ext}`;
        try {
          await putObject(key, data, type.mime);
        } catch (err) {
          console.error('Photo upload failed', key, err);
          throw new ActionError({ code: 'INTERNAL_SERVER_ERROR', message: 'The photo couldn’t be uploaded. Try again in a moment.' });
        }
        previousKey = photoKey !== key ? photoKey : null;
        photoKey = key;
      } else if (input.removePhoto) {
        previousKey = photoKey;
        photoKey = null;
      }

      const values = {
        name: input.name ?? '',
        headline: input.headline ?? '',
        bio: input.bio ?? '',
        photoKey,
        updatedAt: sqlNow(),
      };
      await db
        .insert(tutorProfile)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: tutorProfile.id, set: values });
      if (previousKey) await deleteObjects([previousKey]).catch((err) => console.error('Photo cleanup failed', err));
      return { message: values.name ? 'Profile saved. It now shows on the home page and About page.' : 'Profile saved. It stays hidden until you add a name.' };
    },
  }),
};
