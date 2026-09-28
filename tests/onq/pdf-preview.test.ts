import { describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ getText: vi.fn(), getScreenshot: vi.fn(), destroy: vi.fn() }));
vi.mock('pdf-parse', () => ({ PDFParse: class { getText = fake.getText; getScreenshot = fake.getScreenshot; destroy = fake.destroy; } }));
import { handleGetTopicFile } from '@/mcp/tools/get-topic-file.tool.js';
import { FakeContentRepository } from '@tests/helpers/fakes/FakeContentRepository.js';
describe('sparse lecture PDF', () => {
  it('returns page images with explicit preview limits and releases the parser', async () => {
    fake.getText.mockResolvedValue({ text: 'A diagram', total: 20 });
    fake.getScreenshot.mockResolvedValue({ pages: [{ pageNumber: 1, data: new Uint8Array([1,2,3]) }] });
    fake.destroy.mockResolvedValue(undefined);
    const repo = new FakeContentRepository(); repo.findTopicFile = async () => Buffer.from('%PDF-test');
    const result = await handleGetTopicFile({ contentRepo: repo }, { course_id: 1, topic_id: 2 });
    expect(result.content.some(c => c.type === 'image')).toBe(true);
    expect(fake.getText).toHaveBeenCalledWith({ first: 50 });
    expect(fake.getScreenshot).toHaveBeenCalledWith(expect.objectContaining({ first: 5 }));
    expect(result.content.some(c => c.text?.includes('first 5 pages'))).toBe(true);
    expect(fake.destroy).toHaveBeenCalled();
  });
});
