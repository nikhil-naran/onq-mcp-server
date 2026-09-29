import { describe, expect, it, vi } from 'vitest';
import { handleRetrieveOnqFile, safeFilename } from '@/mcp/tools/retrieve-onq-file.tool.js';
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
import { createHash } from 'node:crypto';
import { D2lApiError, DownloadRejectedError } from '@/contexts/http-api/errors.js';

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

  it('marks an inaccessible historical course as forbidden rather than empty', async () => {
    const repo = new FakeContentRepository();
    vi.spyOn(repo, 'findModules').mockRejectedValue(new D2lApiError(403, '/content/', '{}'));
    const courseRepo = { findMyCourses: vi.fn().mockResolvedValue([course]) };
    const result = await handleFindOnqFiles({ courseRepo: courseRepo as never,
      contentRepo: repo, baseUrl: 'https://onq.queensu.ca' },
      { query: 'slides', course_id: 101, include_past: true });
    expect(result.structuredContent.coverage).toEqual([{ course_id: 101, status: 'forbidden' }]);
    expect(result.structuredContent.status).toBe('unavailable');
    expect(result.content[0]?.text).toContain('inaccessible materials, not zero files');
  });

  it('matches week/lecture numbers exactly and word prefixes, dropping unrelated files', async () => {
    const mods = [
      new Module({ id: 1, title: 'Week 8', submodules: [], topics: [
        new Topic({ id: 81, title: 'Lecture slides', kind: 'file', url: '/content/enforced/101-A/L08.pdf', fileExtension: 'pdf' })] }),
      new Module({ id: 2, title: 'Week 18', submodules: [], topics: [
        new Topic({ id: 181, title: 'Lecture slides', kind: 'file', url: '/content/enforced/101-A/L18.pdf', fileExtension: 'pdf' })] }),
      new Module({ id: 3, title: 'Admin', submodules: [], topics: [
        new Topic({ id: 3, title: 'Policies', kind: 'file', url: '/content/enforced/101-A/policy.docx', fileExtension: 'docx' })] }),
    ];
    const repo = new FakeContentRepository(new Map(), new Map([[101, mods]]));
    const courseRepo = { findMyCourses: vi.fn().mockResolvedValue([course]) };
    const result = await handleFindOnqFiles({ courseRepo: courseRepo as never, contentRepo: repo, baseUrl: 'https://onq.queensu.ca' },
      { query: 'week 8 slide' });
    const refs = result.structuredContent.items.map(i => i.file_ref);
    expect(refs[0]).toBe('onq-file:topic:101:81');
    // "Week 18" still matches "week" and "slide", but ranks below the exact week number.
    expect(refs).toContain('onq-file:topic:101:181');
    expect(refs).not.toContain('onq-file:topic:101:3');
  });

  it('lists a file once when a topic and a description link point to it, with a readable filename', async () => {
    const mods = [new Module({ id: 1, title: 'Syllabus',
      descriptionHtml: '<a href="/content/enforced/101-A/Course%20Outline.pdf">Outline</a>',
      topics: [
        new Topic({ id: 5, title: 'Course outline', kind: 'file', url: '/content/enforced/101-A/Course Outline.pdf', fileExtension: 'pdf' }),
        new Topic({ id: 6, title: 'Reading list', kind: 'file', url: null, fileExtension: 'pdf' }),
      ], submodules: [] })];
    const repo = new FakeContentRepository(new Map(), new Map([[101, mods]]));
    const courseRepo = { findMyCourses: vi.fn().mockResolvedValue([course]) };
    const result = await handleFindOnqFiles({ courseRepo: courseRepo as never, contentRepo: repo, baseUrl: 'https://onq.queensu.ca' },
      { query: 'syllabus' });
    expect(result.structuredContent.items.map(i => [i.file_ref, i.filename])).toEqual([
      ['onq-file:topic:101:5', 'Course Outline.pdf'],
      ['onq-file:topic:101:6', 'Reading list.pdf'],
    ]);
  });

  it('passes through a course HTML page that mentions logging in, but explains broken and link topics', async () => {
    const html = Buffer.from('<!DOCTYPE html><html><body><h1>How to log in to the lab computers</h1></body></html>');
    const mods = [new Module({ id: 1, title: 'Lab', submodules: [], topics: [
      new Topic({ id: 1, title: 'Lab access', kind: 'file', url: '/content/enforced/101-A/Lab%20access.html', fileExtension: 'html' }),
      new Topic({ id: 2, title: 'Old notes', kind: 'file', url: null, fileExtension: 'pdf', isBroken: true }),
      new Topic({ id: 3, title: 'Textbook site', kind: 'link', url: 'https://publisher.example/book', fileExtension: null }),
    ] })];
    const repo = new FakeContentRepository(new Map(), new Map([[101, mods]]));
    vi.spyOn(repo, 'findTopicFile').mockResolvedValue(html);
    const deps = { contentRepo: repo, assignmentRepo: {} as never, communicationsRepo: {} as never, baseUrl: 'https://onq.queensu.ca' };
    const page = await handleRetrieveOnqFile(deps, { file_ref: 'onq-file:topic:101:1' });
    expect(page.structuredContent).toMatchObject({ status: 'ok', filename: 'Lab access.html', mime_type: 'text/html' });
    const broken = await handleRetrieveOnqFile(deps, { file_ref: 'onq-file:topic:101:2' });
    expect(broken.structuredContent).toMatchObject({ error_code: 'not_found' });
    const link = await handleRetrieveOnqFile(deps, { file_ref: 'onq-file:topic:101:3' });
    expect(link.structuredContent).toMatchObject({ error_code: 'unsupported' });
    expect(link.content[0]?.text).toContain('https://publisher.example/book');
  });

  it('flags a login form served in place of any file', async () => {
    const repo = new FakeContentRepository();
    vi.spyOn(repo, 'findCourseFile').mockResolvedValue(Buffer.from('<html><form action="/d2l/lp/auth/login/login.d2l"><input type="password"></form></html>'));
    const result = await handleRetrieveOnqFile({ contentRepo: repo, assignmentRepo: {} as never,
      communicationsRepo: {} as never, baseUrl: 'https://onq.queensu.ca' },
      { file_ref: encodeOnqFileRef({ source: 'path', courseId: 101, path: '/content/enforced/101-A/page.html' }) });
    expect(result.structuredContent).toMatchObject({ error_code: 'expired_auth' });
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
      const result = await handleRetrieveOnqFile(deps, { file_ref: ref });
      const r = fileResource(result);
      expect(r.mimeType).toBe(mime);
      expect(Buffer.from(r.blob, 'base64')).toEqual(original);
      expect(result.structuredContent).toMatchObject({ file_ref: ref, filename: expect.any(String),
        mime_type: mime, byte_length: original.length,
        sha256: createHash('sha256').update(original).digest('hex') });
    }
  });

  it('gives checkable save steps and never asks the client to extract text', async () => {
    const repo = new FakeContentRepository(new Map(), new Map([[101, modules]]));
    const pdf = buildPdf(['ASIL matrix']);
    vi.spyOn(repo, 'findTopicFile').mockResolvedValue(pdf);
    const result = await handleRetrieveOnqFile({ contentRepo: repo, assignmentRepo: {} as never,
      communicationsRepo: {} as never, baseUrl: 'https://onq.queensu.ca' }, { file_ref: 'onq-file:topic:101:8' });
    const base64Length = fileResource(result).blob.length;
    expect(result.structuredContent).toMatchObject({ save_as: '92817.pdf', base64_length: base64Length, byte_length: pdf.length });
    const guide = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(guide).toContain(`exactly ${base64Length} characters`);
    expect(guide).toContain(`exactly ${pdf.length} bytes`);
    expect(guide).toContain('Never use or link a partial copy');
    expect(guide).toMatch(/render the pages you need to images and look at them/);
    expect(guide).not.toMatch(/pdftotext|text layer/i);
  });

  it('makes workspace-safe filenames that keep the extension', () => {
    expect(safeFilename('4 - risk.pdf')).toBe('4 - risk.pdf');
    expect(safeFilename('../../etc/pass:wd?.pdf')).toBe('_etc_pass_wd_.pdf');
    expect(safeFilename('Capítulo 1.pdf')).toBe('Capítulo 1.pdf');
    expect(safeFilename('...')).toBe('onq-file');
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

  it('reports denied and oversized downloads with distinct error codes', async () => {
    const repo = new FakeContentRepository();
    const binary = vi.spyOn(repo, 'findTopicFile').mockRejectedValueOnce(new D2lApiError(403, '/file', '{}'))
      .mockRejectedValueOnce(new DownloadRejectedError('too_large', 'Download exceeds 25 MB limit'));
    const deps = { contentRepo: repo, assignmentRepo: {} as never,
      communicationsRepo: {} as never, baseUrl: 'https://onq.queensu.ca' };
    const ref = encodeOnqFileRef({ source: 'topic', courseId: 101, topicId: 8 });
    expect((await handleRetrieveOnqFile(deps, { file_ref: ref })).structuredContent).toMatchObject({ error_code: 'forbidden' });
    expect((await handleRetrieveOnqFile(deps, { file_ref: ref })).structuredContent).toMatchObject({ error_code: 'too_large' });
    expect(binary).toHaveBeenCalledTimes(2);
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
