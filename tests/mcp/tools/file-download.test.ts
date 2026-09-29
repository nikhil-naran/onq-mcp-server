import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { handleRetrieveOnqFile } from '@/mcp/tools/retrieve-onq-file.tool.js';
import { WindowsFileDelivery } from '@/contexts/onq/infrastructure/WindowsFileDelivery.js';
import { FakeContentRepository } from '@tests/helpers/fakes/FakeContentRepository.js';
import { FakeAssignmentRepository } from '@tests/helpers/fakes/FakeAssignmentRepository.js';
import { FakeCommunicationsRepository } from '@tests/helpers/fakes/FakeCommunicationsRepository.js';
import { Module } from '@/contexts/content/domain/Module.js';
import { Topic } from '@/contexts/content/domain/Topic.js';
import { Announcement } from '@/contexts/communications/domain/Announcement.js';
import { encodeOnqFileRef } from '@/mcp/onq-file-ref.js';
import { D2lApiError } from '@/contexts/http-api/errors.js';

const services: WindowsFileDelivery[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.dispose())); });
async function setup() {
  const service = new WindowsFileDelivery({ publicBaseUrl: 'https://downloads.example.com', port: 0,
    ttlSeconds: 900, maxBytes: 128 * 1024 * 1024, maxFileBytes: 25 * 1024 * 1024,
    maxEntries: 16, maxConcurrentRetrievals: 2, maxConcurrentResponses: 16 });
  services.push(service);
  await service.start();
  const data = Buffer.from('%PDF-1.7\nOriginal bytes\n%%EOF');
  const contentRepo = new FakeContentRepository(new Map(), new Map([[101, [new Module({ id: 1, title: 'Slides',
    submodules: [], topics: [new Topic({ id: 8, title: 'Lecture', kind: 'file',
      url: '/content/enforced/101-A/lecture.pdf', fileExtension: 'pdf' })] })]]]));
  vi.spyOn(contentRepo, 'findTopicFile').mockResolvedValue(data);
  vi.spyOn(contentRepo, 'findCourseFile').mockResolvedValue(data);
  const assignmentRepo = new FakeAssignmentRepository();
  vi.spyOn(assignmentRepo, 'findFiles').mockResolvedValue({ assignmentId: '42', assignmentName: 'Lab', instructions: '',
    files: [{ name: 'lecture.pdf', url: '/d2l/file' }] });
  vi.spyOn(assignmentRepo, 'findFileBinary').mockResolvedValue(data);
  vi.spyOn(assignmentRepo, 'findMySubmissions').mockResolvedValue([{ id: '6', submittedAt: null,
    submittedAtLabel: null, submittedBy: null, comment: null,
    files: [{ name: 'lecture.pdf', sizeBytes: null, sizeLabel: null, url: '/d2l/file' }] }]);
  const communicationsRepo = new FakeCommunicationsRepository(new Map([[101, [new Announcement({ id: 7,
    courseOrgUnitId: 101, title: 'Slides', html: null, authorName: null, postedAt: new Date(),
    attachments: [{ id: 9, name: 'lecture.pdf', size: data.length }] })]]]));
  vi.spyOn(communicationsRepo, 'downloadAnnouncementAttachment').mockResolvedValue(data);
  return { service, data, deps: { fileDelivery: service, contentRepo, assignmentRepo, communicationsRepo, baseUrl: 'https://onq.queensu.ca' } };
}

describe('onQ original download links', () => {
  it('delivers all five source kinds as checksum-identical URLs without base64', async () => {
    const { service, data, deps } = await setup();
    for (const file_ref of ['onq-file:topic:101:8',
      encodeOnqFileRef({ source: 'path', courseId: 101, path: '/content/enforced/101-A/lecture.pdf' }),
      'onq-file:assignment:101:42:lecture.pdf', 'onq-file:announcement:101:7:9', 'onq-file:submission:101:42:6:lecture.pdf']) {
      const result = await handleRetrieveOnqFile(deps, { file_ref });
      expect(result.structuredContent).toMatchObject({ status: 'ok', delivery: 'download_url', file_ref,
        byte_length: data.length, sha256: createHash('sha256').update(data).digest('hex') });
      const block = result.content.find(b => b.type === 'resource_link');
      if (!block || block.type !== 'resource_link') throw new Error('Missing download link');
      const response = await fetch(service.localUrl + new URL(block.uri).pathname);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
      expect(JSON.stringify(result)).not.toContain('"blob"');
      expect(JSON.stringify(result)).not.toContain('base64_length');
    }
  });

  it('delivers files above the inline cap but preserves the source 25 MiB limit', async () => {
    const { service, deps } = await setup();
    const data = Buffer.alloc(7 * 1024 * 1024, 0x5a);
    vi.mocked(deps.contentRepo.findTopicFile).mockResolvedValue(data);
    const result = await handleRetrieveOnqFile(deps, { file_ref: 'onq-file:topic:101:8' });
    expect(JSON.stringify(result).length).toBeLessThan(4096);
    const block = result.content.find(b => b.type === 'resource_link');
    if (!block || block.type !== 'resource_link') throw new Error('Missing download link');
    const received = Buffer.from(await (await fetch(service.localUrl + new URL(block.uri).pathname)).arrayBuffer());
    expect(received.length).toBe(data.length);
    expect(createHash('sha256').update(received).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
    vi.mocked(deps.contentRepo.findTopicFile).mockResolvedValue(Buffer.alloc(25 * 1024 * 1024 + 1));
    expect((await handleRetrieveOnqFile(deps, { file_ref: 'onq-file:topic:101:8' })).structuredContent).toMatchObject({ error_code: 'too_large' });
  });

  it('does not publish login/empty/forbidden responses and releases failed reservations', async () => {
    const { deps } = await setup();
    for (const data of [Buffer.alloc(0), Buffer.from('<html><input type="password"></html>')]) {
      vi.mocked(deps.contentRepo.findTopicFile).mockResolvedValue(data);
      const result = await handleRetrieveOnqFile(deps, { file_ref: 'onq-file:topic:101:8' });
      expect(result).toHaveProperty('isError', true);
      expect(JSON.stringify(result)).not.toContain('download_url');
    }
    vi.mocked(deps.contentRepo.findTopicFile).mockRejectedValue(new D2lApiError(403, '/file', '{}'));
    for (let i = 0; i < 4; i++)
      expect((await handleRetrieveOnqFile(deps, { file_ref: 'onq-file:topic:101:8' })).structuredContent).toMatchObject({ error_code: 'forbidden' });
  });

  it('fails explicitly when the listener is down without falling back to embedded bytes', async () => {
    const { deps, service } = await setup();
    await service.dispose();
    expect((await handleRetrieveOnqFile(deps, { file_ref: 'onq-file:topic:101:8' })).structuredContent).toMatchObject({ error_code: 'delivery_unavailable' });
    expect(deps.contentRepo.findTopicFile).not.toHaveBeenCalled();
  });
});
