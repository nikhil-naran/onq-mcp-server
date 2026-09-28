import { z } from 'zod';
import type { CommunicationsRepository } from '@/contexts/communications/domain/CommunicationsRepository.js';
import { getAnnouncement } from '@/contexts/communications/application/getAnnouncement.js';
import { announcementToText } from '@/mcp/announcement-helpers.js';
import { OrgUnitId } from '@/shared-kernel/types/OrgUnitId.js';
import type { OutputContext } from '@/shared-kernel/output/index.js';

export const getAnnouncementSchema = z
  .object({
    course_id: z.number().int().positive(),
    announcement_id: z.number().int().positive(),
  })
  .strict();

export interface GetAnnouncementDeps { communicationsRepo: CommunicationsRepository; output: OutputContext; }

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function notFound(courseId: number, announcementId: number) {
  return text(
    `Announcement ${announcementId} not found in course ${courseId} (it may be hidden or deleted). ` +
      `Use get_announcements(course_id=${courseId}) to list the current ones.`,
  );
}

export async function handleGetAnnouncement(deps: GetAnnouncementDeps, rawInput: unknown) {
  const input = getAnnouncementSchema.parse(rawInput);
  const courseId = OrgUnitId.of(input.course_id);
  const a = await getAnnouncement({ repo: deps.communicationsRepo, courseId, announcementId: input.announcement_id });
  if (!a) return notFound(input.course_id, input.announcement_id);
  const footer = deps.output.metaFooter();
  return text([announcementToText(a, deps.output), a.attachments.length ? 'Use retrieve_onq_file(file_ref) for the original attachment.' : '', footer].filter(Boolean).join('\n\n'));
}
