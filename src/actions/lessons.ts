import { defineAction, ActionError } from 'astro:actions';
import { z } from 'astro/zod';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { chapters, lessonFiles, lessons, subjects, type FileKind } from '../db/schema';
import { t } from '../i18n';
import { deleteUnreferencedObjects, moveRow, nextPosition, requireAdmin, sqlNow } from '../lib/admin';
import { getDb } from '../lib/db';
import { FILE_KINDS, MAX_FILE_BYTES, MAX_SAVE_BYTES, fileKey, formatBytes, looksLikePdf, sha256Hex } from '../lib/files';
import { removeFromSearchIndex, syncSearchIndex } from '../lib/search-index';
import { SLUG_PATTERN, slugify } from '../lib/slug';
import { putObject } from '../lib/storage';
import { checkVideo, parseYouTubeId } from '../lib/youtube';
import { attemptLogin } from './auth';

export type LessonFormValues = {
  id: string;
  intent: string;
  chapterId: string;
  newChapterSubjectId: string;
  newChapterName: string;
  title: string;
  slug: string;
  description: string;
  youtube: string;
  removeFiles: string[];
  fileOrder: string[];
  kinds: Record<string, string>;
};

export type SaveLessonResult =
  | { ok: true; id: number; status: 'draft' | 'published'; videoStatus: 'ok' | 'unavailable' | 'unchecked' }
  | {
      ok: false;
      reason: 'invalid' | 'session' | 'server';
      message?: string;
      errors: Record<string, string>;
      values: LessonFormValues;
      hadNewFiles: boolean;
    };

const str = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

function readValues(form: FormData): LessonFormValues {
  const kinds: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith('kind_') && typeof value === 'string') kinds[key.slice(5)] = value;
  }
  return {
    id: str(form, 'id'),
    intent: str(form, 'intent'),
    chapterId: str(form, 'chapterId'),
    newChapterSubjectId: str(form, 'newChapterSubjectId'),
    newChapterName: str(form, 'newChapterName'),
    title: str(form, 'title'),
    slug: str(form, 'slug').toLowerCase(),
    description: str(form, 'description'),
    youtube: str(form, 'youtube'),
    removeFiles: form.getAll('removeFile').map(String),
    fileOrder: form.getAll('fileOrder').map(String),
    kinds,
  };
}

function newFilesFrom(form: FormData) {
  return FILE_KINDS.flatMap((kind) =>
    form
      .getAll(`new_${kind}`)
      .filter((v): v is File => v instanceof File && v.size > 0)
      .map((file) => ({ kind, file })),
  );
}

export const lessonActions = {
  saveLesson: defineAction({
    accept: 'form',
    handler: async (form: FormData, context): Promise<SaveLessonResult> => {
      const values = readValues(form);
      const incoming = newFilesFrom(form);
      const fail = (reason: 'invalid' | 'session' | 'server', errors: Record<string, string>, message?: string) => ({
        ok: false as const,
        reason,
        errors,
        message,
        values,
        hadNewFiles: incoming.length > 0,
      });

      // Expired session: re-authenticate inline rather than losing the tutor's work.
      if (!context.locals.isAdmin) {
        const password = str(form, 'reauthPassword');
        if (!password) return fail('session', {}, t('admin.sessionExpired'));
        const login = await attemptLogin(password, context);
        if (!login.ok) return fail('session', { reauthPassword: login.message }, t('admin.sessionExpired'));
      }

      const db = getDb();
      const errors: Record<string, string> = {};
      const intent = values.intent;

      const existingId = values.id ? Number(values.id) : null;
      const [existing] = existingId ? await db.select().from(lessons).where(eq(lessons.id, existingId)) : [];
      if (existingId && !existing) return fail('server', {}, 'This lesson no longer exists. It may have been deleted.');

      const targetStatus: 'draft' | 'published' =
        intent === 'publish' ? 'published' : intent === 'unpublish' || intent === 'draft' ? 'draft' : (existing?.status ?? 'draft');

      // Where it lives
      let subjectId: number | null = null;
      let chapterId: number | null = null;
      if (values.chapterId === 'new') {
        const sid = Number(values.newChapterSubjectId);
        const [subject] = sid ? await db.select().from(subjects).where(eq(subjects.id, sid)) : [];
        if (!subject) errors.newChapterSubjectId = 'Choose which subject the new chapter belongs to.';
        else subjectId = subject.id;
        if (!values.newChapterName) errors.newChapterName = 'Give the new chapter a name.';
        else if (values.newChapterName.length > 120) errors.newChapterName = 'Keep the chapter name under 120 characters.';
      } else {
        const cid = Number(values.chapterId);
        const [chapter] = cid ? await db.select().from(chapters).where(eq(chapters.id, cid)) : [];
        if (!chapter) errors.chapterId = 'Choose a chapter for this lesson.';
        else {
          chapterId = chapter.id;
          subjectId = chapter.subjectId;
        }
      }
      if (existing?.publishedAt && subjectId && subjectId !== existing.subjectId) {
        errors.chapterId = 'Published lessons can only move between chapters of the same subject, so shared links keep working.';
      }

      // Lesson text
      if (values.title.length < 3) errors.title = 'Give the lesson a title of at least 3 characters.';
      else if (values.title.length > 140) errors.title = 'Keep the title under 140 characters.';
      if (values.description.length > 5000) errors.description = 'Keep the description under 5,000 characters.';

      const slugLocked = !!existing?.publishedAt;
      const slug = slugLocked ? existing.slug : values.slug || slugify(values.title);
      if (!slugLocked) {
        if (!slug || !SLUG_PATTERN.test(slug)) {
          errors.slug = 'Use lowercase letters, numbers and single hyphens. Example: pointers-in-c';
        } else if (subjectId) {
          const clash = await db
            .select({ id: lessons.id })
            .from(lessons)
            .where(
              and(eq(lessons.subjectId, subjectId), eq(lessons.slug, slug), existing ? ne(lessons.id, existing.id) : undefined),
            );
          if (clash.length) errors.slug = 'Another lesson in this subject already uses this link. Try adding a number or a word.';
        }
      }

      // Video
      const youtubeId = values.youtube ? parseYouTubeId(values.youtube) : null;
      if (values.youtube && !youtubeId) {
        errors.youtube = 'Paste a YouTube link (like https://youtu.be/dQw4w9WgXcQ) or the 11-character video ID.';
      }

      // Files
      const currentFiles = existing ? await db.select().from(lessonFiles).where(eq(lessonFiles.lessonId, existing.id)) : [];
      const removeIds = new Set(values.removeFiles.map(Number));
      const keptFiles = currentFiles.filter((f) => !removeIds.has(f.id));
      let incomingBytes = 0;
      for (const { file } of incoming) {
        incomingBytes += file.size;
        if (file.size > MAX_FILE_BYTES) {
          errors.files = `“${file.name}” is ${formatBytes(file.size)}. Each PDF can be up to ${formatBytes(MAX_FILE_BYTES)}.`;
        }
      }
      if (!errors.files && incomingBytes > MAX_SAVE_BYTES) {
        errors.files = `These PDFs add up to ${formatBytes(incomingBytes)}. Upload up to ${formatBytes(MAX_SAVE_BYTES)} per save, then add the rest.`;
      }

      if (targetStatus === 'published' && !youtubeId && keptFiles.length + incoming.length === 0) {
        errors.artifacts = 'Add a YouTube video or at least one PDF before publishing.';
      }

      if (Object.keys(errors).length) return fail('invalid', errors);

      // Read, verify and store new PDFs before touching the database.
      const uploads: { kind: FileKind; key: string; size: number; name: string; hash: string }[] = [];
      for (const { kind, file } of incoming) {
        const data = await file.arrayBuffer();
        if (!looksLikePdf(data)) return fail('invalid', { files: `“${file.name}” isn’t a PDF. Export it as PDF and try again.` });
        const hash = await sha256Hex(data);
        const key = fileKey(hash, file.name);
        uploads.push({ kind, key, size: file.size, name: file.name, hash });
        try {
          await putObject(key, data, 'application/pdf');
        } catch (err) {
          console.error('PDF upload failed', key, err);
          await deleteUnreferencedObjects(uploads.map((u) => u.key));
          return fail('server', {}, `“${file.name}” couldn’t be uploaded. Nothing was changed. Try again in a moment.`);
        }
      }
      const uploadedKeys = uploads.map((u) => u.key);

      // Video availability is checked here because an embedded player can't report it.
      let videoStatus: 'ok' | 'unavailable' | 'unchecked' = 'unchecked';
      if (youtubeId) {
        const unchanged = existing?.youtubeId === youtubeId && existing.videoStatus !== 'unchecked';
        videoStatus = unchanged ? existing.videoStatus : (await checkVideo(youtubeId)).status;
      }

      const now = sqlNow();
      let lessonId = existing?.id ?? 0;
      let createdChapterId: number | null = null;
      let createdLesson = false;
      try {
        if (values.chapterId === 'new' && subjectId) {
          const [created] = await db
            .insert(chapters)
            .values({ subjectId, name: values.newChapterName, position: await nextPosition('chapters', 'subject_id', subjectId) })
            .returning({ id: chapters.id });
          chapterId = createdChapterId = created.id;
        }

        const movedChapter = !existing || existing.chapterId !== chapterId;
        const fields = {
          subjectId: subjectId!,
          chapterId: chapterId!,
          title: values.title,
          slug,
          description: values.description,
          youtubeId,
          videoStatus,
          status: targetStatus,
          publishedAt: existing?.publishedAt ?? (targetStatus === 'published' ? now : null),
          updatedAt: now,
          ...(movedChapter ? { position: await nextPosition('lessons', 'chapter_id', chapterId!) } : {}),
        };

        if (existing) await db.update(lessons).set(fields).where(eq(lessons.id, existing.id));
        else {
          const [created] = await db.insert(lessons).values(fields).returning({ id: lessons.id });
          lessonId = created.id;
          createdLesson = true;
        }

        // Positions: kept files in the order shown in the form, then new uploads, per kind.
        const orderIndex = new Map(values.fileOrder.map((id, i) => [Number(id), i]));
        const kept = keptFiles
          .map((f) => {
            const kind = values.kinds[f.id] as FileKind | undefined;
            return { ...f, kind: kind && FILE_KINDS.includes(kind) ? kind : f.kind };
          })
          .sort((a, b) => (orderIndex.get(a.id) ?? a.position) - (orderIndex.get(b.id) ?? b.position));
        const nextByKind = new Map<FileKind, number>();
        const take = (kind: FileKind) => {
          const n = nextByKind.get(kind) ?? 0;
          nextByKind.set(kind, n + 1);
          return n;
        };

        const statements = [
          ...(removeIds.size && existing
            ? [db.delete(lessonFiles).where(and(eq(lessonFiles.lessonId, existing.id), inArray(lessonFiles.id, [...removeIds])))]
            : []),
          ...kept.map((f) => db.update(lessonFiles).set({ kind: f.kind, position: take(f.kind) }).where(eq(lessonFiles.id, f.id))),
          ...uploads.map((u) =>
            db.insert(lessonFiles).values({
              lessonId,
              r2Key: u.key,
              kind: u.kind,
              position: take(u.kind),
              sizeBytes: u.size,
              originalName: u.name,
              sha256: u.hash,
            }),
          ),
        ];
        if (statements.length) await db.batch(statements as [(typeof statements)[number], ...typeof statements]);
      } catch (err) {
        console.error('Lesson save failed', err);
        if (createdLesson) await db.delete(lessons).where(eq(lessons.id, lessonId)).catch(() => {});
        if (createdChapterId) await db.delete(chapters).where(eq(chapters.id, createdChapterId)).catch(() => {});
        await deleteUnreferencedObjects(uploadedKeys);
        return fail('server', {}, 'Something went wrong saving this lesson. Nothing was changed. Try again in a moment.');
      }

      await deleteUnreferencedObjects(currentFiles.filter((f) => removeIds.has(f.id)).map((f) => f.r2Key));
      await syncSearchIndex([lessonId]);

      return { ok: true, id: lessonId, status: targetStatus, videoStatus };
    },
  }),

  deleteLesson: defineAction({
    accept: 'form',
    input: z.object({ id: z.coerce.number().int().positive() }),
    handler: async ({ id }, context) => {
      requireAdmin(context);
      const db = getDb();
      const [lesson] = await db.select({ title: lessons.title }).from(lessons).where(eq(lessons.id, id));
      if (!lesson) return { deleted: true, title: '' };
      const files = await db.select({ key: lessonFiles.r2Key }).from(lessonFiles).where(eq(lessonFiles.lessonId, id));
      // lesson_files rows cascade with the lesson; then the stored objects go if nothing else uses them.
      await db.delete(lessons).where(eq(lessons.id, id));
      await removeFromSearchIndex([id]);
      await deleteUnreferencedObjects(files.map((f) => f.key));
      return { deleted: true, title: lesson.title };
    },
  }),

  recheckVideo: defineAction({
    accept: 'form',
    input: z.object({ id: z.coerce.number().int().positive() }),
    handler: async ({ id }, context) => {
      requireAdmin(context);
      const db = getDb();
      const [lesson] = await db.select({ youtubeId: lessons.youtubeId }).from(lessons).where(eq(lessons.id, id));
      if (!lesson?.youtubeId) throw new ActionError({ code: 'BAD_REQUEST', message: 'This lesson has no video to check.' });
      const { status } = await checkVideo(lesson.youtubeId);
      await db.update(lessons).set({ videoStatus: status }).where(eq(lessons.id, id));
      return { id, status };
    },
  }),

  moveLesson: defineAction({
    accept: 'form',
    input: z.object({ id: z.coerce.number().int().positive(), direction: z.enum(['up', 'down']) }),
    handler: async ({ id, direction }, context) => {
      requireAdmin(context);
      await moveRow({ table: 'lessons', scopeColumn: 'chapter_id' }, id, direction);
      return { moved: true };
    },
  }),
};
