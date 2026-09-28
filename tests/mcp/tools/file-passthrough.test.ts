import { describe, expect, it, vi } from 'vitest';
import { handleRetrieveOnqFile } from '@/mcp/tools/retrieve-onq-file.tool.js';
import { handleFindOnqFiles } from '@/mcp/tools/find-onq-files.tool.js';
import { handleGetAssignmentFiles } from '@/mcp/tools/get-assignment-files.tool.js';
import { handleGetMySubmissions } from '@/mcp/tools/get-my-submissions.tool.js';
import { handleGetAnnouncement } from '@/mcp/tools/get-announcement.tool.js';
import { encodeOnqFileRef, parseOnqFileRef } from '@/mcp/onq-file-ref.js';
import { FakeContentRepository } from '@tests/helpers/fakes/FakeContentRepository.js';
import { FakeAssignmentRepository } from '@tests/helpers/fakes/FakeAssignmentRepository.js';
import { FakeCommunicationsRepository } from '@tests/helpers/fakes/FakeCommunicationsRepository.js';
import { Module } from '@/contexts/content/domain/Module.js';
import { Topic } from '@/contexts/content/domain/Topic.js';
import { Course } from '@/contexts/courses/domain/Course.js';
import { CourseId } from '@/contexts/courses/domain/CourseId.js';
import { Announcement } from '@/contexts/communications/domain/Announcement.js';
import { testOutputContext } from '../../helpers/test-output-context.js';
import { buildPdf, buildPptx } from '@tests/helpers/zip.js';

const course = new Course({ id: CourseId.of(101), name: 'Biology of Cells', code: 'BIOL101', active: true });
const modules = [new Module({ id: 1, title: 'Week 8 cell diagrams and lecture slides',
  descriptionHtml: '<p>Chloroplast lecture slides and companion notes</p><a href="/content/enforced/101-A/a9f2.pptx">Slide deck</a>',
  topics: [new Topic({ id: 8, title: 'Lecture material', kind: 'file', url: '/content/enforced/101-A/92817.pdf', fileExtension: '.pdf' })],
  submodules: [],
})];

function fileResource(result: Awaited<ReturnType<typeof handleRetrieveOnqFile>>) {
  const block = result.content[1];
  if (block?.type !== 'resource') throw new Error('Expected embedded file');
  return block.resource;
}

describe('universal OnQ file retrieval', () => {
  it('finds a random-name file using module context without downloading it', async () => {
    const repo = new FakeContentRepository(new Map(), new Map([[101, modules]]));
    const courseRepo = { findMyCourses: vi.fn().mockResolvedValue([course]) };
    const result = await handleFindOnqFiles({ courseRepo: courseRepo as never, contentRepo: repo, baseUrl: 'https://onq.queensu.ca' },
      { query: 'chloroplast slides' });
    const body = result.content[0]?.text ?? '';
    expect(body).toContain('onq-file:topic:101:8');
    expect(body).toContain('onq-file:path:101:');
    expect(body).toContain('92817.pdf');
    expect(body).toContain('Chloroplast');
  });

  it('passes complete PDF, PowerPoint, and Markdown bytes without parsing them', async () => {
    const repo = new FakeContentRepository(new Map(), new Map([[101, modules]]));
    const pdf = buildPdf(['first', 'later page']);
    const pptx = buildPptx([['opening'], ['diagram on later slide']]);
    const md = Buffer.from('# Notes\nOriginal *Markdown*\n');
    vi.spyOn(repo, 'findTopicFile').mockResolvedValue(pdf);
    vi.spyOn(repo, 'findCourseFile').mockImplementation(async (_course, path) => path.filename.endsWith('pptx') ? pptx : md);
    const deps = { contentRepo: repo, assignmentRepo: {} as never, communicationsRepo: {} as never, baseUrl: 'https://onq.queensu.ca' };
    for (const [ref, original, mime] of [
      [encodeOnqFileRef({ source: 'topic', courseId: 101, topicId: 8 }), pdf, 'application/pdf'],
      [encodeOnqFileRef({ source: 'path', courseId: 101, path: '/content/enforced/101-A/a9f2.pptx' }), pptx, 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      [encodeOnqFileRef({ source: 'path', courseId: 101, path: '/content/enforced/101-A/random.md' }), md, 'text/markdown'],
    ] as const) {
      const r = fileResource(await handleRetrieveOnqFile(deps, { file_ref: ref }));
      expect(r.mimeType).toBe(mime);
      expect(Buffer.from(r.blob, 'base64')).toEqual(original);
    }
  });

  it('rejects another course path and a sign-in response', async () => {
    expect(() => parseOnqFileRef(encodeOnqFileRef({ source: 'path', courseId: 101, path: '/content/enforced/999-X/a.pdf' }))).toThrow();
    const repo = new FakeContentRepository();
    vi.spyOn(repo, 'findCourseFile').mockResolvedValue(Buffer.from('<html><title>Sign in</title></html>'));
    const result = await handleRetrieveOnqFile({ contentRepo: repo, assignmentRepo: {} as never,
      communicationsRepo: {} as never, baseUrl: 'https://onq.queensu.ca' },
      { file_ref: encodeOnqFileRef({ source: 'path', courseId: 101, path: '/content/enforced/101-A/a.pdf' }) });
    expect(result).toHaveProperty('isError', true);
  });

  it('lists attachment references and retrieves the original only when requested', async () => {
    const assignmentRepo = new FakeAssignmentRepository();
    const binary = Buffer.from('raw attachment bytes');
    vi.spyOn(assignmentRepo, 'findFiles').mockResolvedValue({ assignmentId: '42', assignmentName: 'Lab', instructions: 'Instructions',
      files: [{ name: 'random.txt', url: '/d2l/file' }] });
    vi.spyOn(assignmentRepo, 'findFileBinary').mockResolvedValue(binary);
    const contentRepo = new FakeContentRepository();
    const listed = await handleGetAssignmentFiles({ assignmentRepo, contentRepo }, { course_id: 101, assignment_id: 42 });
    expect(listed.content[0]?.text).toContain('onq-file:assignment:101:42:random.txt');
    expect(assignmentRepo.findFileBinary).not.toHaveBeenCalled();
    const retrieved = await handleRetrieveOnqFile({ assignmentRepo, contentRepo,
      communicationsRepo: {} as never, baseUrl: 'https://onq.queensu.ca' },
      { file_ref: 'onq-file:assignment:101:42:random.txt' });
    expect(Buffer.from(fileResource(retrieved).blob, 'base64')).toEqual(binary);
  });

  it('lists submitted and announcement files as references, without downloading them', async () => {
    const assignmentRepo = new FakeAssignmentRepository();
    vi.spyOn(assignmentRepo, 'findFileBinary');
    vi.spyOn(assignmentRepo, 'findMySubmissions').mockResolvedValue([{
      id: '6', submittedAt: null, submittedAtLabel: null, submittedBy: null, comment: null,
      files: [{ name: 'notes.md', sizeBytes: null, sizeLabel: null, url: '/d2l/submission' }],
    }]);
    const submissions = await handleGetMySubmissions({ assignmentRepo }, { course_id: 101, assignment_id: 42 });
    expect(submissions.content[0]?.text).toContain('onq-file:submission:101:42:6:notes.md');
    expect(assignmentRepo.findFileBinary).not.toHaveBeenCalled();
    const announcement = new Announcement({ id: 7, courseOrgUnitId: 101, title: 'Lecture notes', html: null,
      authorName: null, postedAt: new Date(), attachments: [{ id: 9, name: 'notes.pdf', size: 10 }] });
    const communicationsRepo = new FakeCommunicationsRepository(new Map([[101, [announcement]]]));
    const listed = await handleGetAnnouncement({ communicationsRepo, output: testOutputContext() }, { course_id: 101, announcement_id: 7 });
    expect(listed.content[0]?.text).toContain('onq-file:announcement:101:7:9');
  });
});
