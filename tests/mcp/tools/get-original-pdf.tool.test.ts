import { describe, expect, it, vi } from 'vitest';

import { handleGetOriginalPdf } from '@/mcp/tools/get-original-pdf.tool.js';
import { FakeContentRepository } from '@tests/helpers/fakes/FakeContentRepository.js';
import { buildPdf } from '@tests/helpers/zip.js';

const deps = (contentRepo: FakeContentRepository) => ({ contentRepo, baseUrl: 'https://onq.queensu.ca' });

describe('get_original_pdf', () => {
  it('returns the exact original PDF bytes as an embedded MCP resource', async () => {
    const original = buildPdf(['First page', 'Middle page', 'Last page with diagram']);
    const repo = new FakeContentRepository();
    vi.spyOn(repo, 'findCourseFile').mockResolvedValue(original);
    const result = await handleGetOriginalPdf(deps(repo), {
      course_id: 101,
      path: '/content/enforced/101-COURSE/lecture.pdf',
    });

    expect(result).not.toHaveProperty('isError');
    const resource = result.content[1];
    expect(resource?.type).toBe('resource');
    if (resource?.type !== 'resource') throw new Error('Expected PDF resource');
    expect(resource.resource.mimeType).toBe('application/pdf');
    expect(Buffer.from(resource.resource.blob, 'base64')).toEqual(original);
    expect(result.content[0]).toHaveProperty('text', expect.stringContaining('No text or page images were extracted'));
  });

  it('rejects an HTML login response and another course path', async () => {
    const repo = new FakeContentRepository();
    vi.spyOn(repo, 'findCourseFile').mockResolvedValue(Buffer.from('<html>Sign in</html>'));
    const login = await handleGetOriginalPdf(deps(repo), {
      course_id: 101,
      path: '/content/enforced/101-COURSE/lecture.pdf',
    });
    expect(login.isError).toBe(true);

    await expect(handleGetOriginalPdf(deps(repo), {
      course_id: 101,
      path: '/content/enforced/999-OTHER/lecture.pdf',
    })).rejects.toThrow();
  });
});
