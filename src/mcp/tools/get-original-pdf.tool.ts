import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { ContentRepository } from '@/contexts/content/domain/ContentRepository.js';
import { getCourseFile } from '@/contexts/content/application/getCourseFile.js';
import { readTopic } from '@/contexts/content/application/readTopic.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export const getOriginalPdfSchema = z.object({
  course_id: z.number().int().positive(),
  topic_id: z.number().int().positive().optional().describe('File topic ID from get_course_content.'),
  path: z.string().min(1).max(2048).optional().describe(
    'Course-scoped /content/enforced/... PDF path from get_course_content or get_module.',
  ),
}).strict().refine(input => (input.topic_id === undefined) !== (input.path === undefined), {
  message: 'Provide exactly one of topic_id or path.',
});

export interface GetOriginalPdfDeps {
  contentRepo: ContentRepository;
  baseUrl: string;
}

const error = (message: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text: message }],
});

/** Return original PDF bytes to the MCP host; never parse, render, or save them here. */
export async function handleGetOriginalPdf(deps: GetOriginalPdfDeps, rawInput: unknown) {
  const input = getOriginalPdfSchema.parse(rawInput);
  const courseId = OrgUnitId.of(input.course_id);
  let pdf: Buffer;
  let name: string;

  if (input.topic_id !== undefined) {
    const topic = await readTopic({ repo: deps.contentRepo, courseId, topicId: input.topic_id });
    if (topic.status !== 'file') return error('This topic has no downloadable file.');
    pdf = topic.content;
    name = topic.topic?.title ?? `Topic ${input.topic_id}`;
  } else {
    const file = await getCourseFile({
      repo: deps.contentRepo,
      courseId,
      rawPath: input.path!,
      origin: deps.baseUrl,
    });
    pdf = file.content;
    name = file.path.filename;
  }

  if (pdf.length > MAX_PDF_BYTES) return error(`PDF exceeds the ${MAX_PDF_BYTES / 1024 / 1024} MB limit.`);
  if (!pdf.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    return error('OnQ did not return a PDF. The login session may have expired or this link points elsewhere.');
  }

  const digest = createHash('sha256').update(pdf).digest('hex');
  return {
    content: [
      {
        type: 'text' as const,
        text: `Original OnQ PDF: ${name} (${pdf.length} bytes). The complete PDF is in the attached resource. ` +
          'No text or page images were extracted by the server. If this client cannot read the attached PDF, say so; ' +
          'do not infer its later pages from this description.',
      },
      {
        type: 'resource' as const,
        resource: {
          uri: `onq-pdf://course/${input.course_id}/${digest}`,
          mimeType: 'application/pdf',
          blob: pdf.toString('base64'),
        },
      },
    ],
  };
}
