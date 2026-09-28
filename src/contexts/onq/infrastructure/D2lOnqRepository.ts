import type { D2lApiClient } from '@/contexts/http-api/D2lApiClient.js';
import { D2lApiError } from '@/contexts/http-api/errors.js';
import type { OnqRepository, OnqDetails, OnqCompletions } from '../domain/OnqRepository.js';

export class D2lOnqRepository implements OnqRepository {
  constructor(private readonly client: D2lApiClient, private readonly le: string, private readonly baseUrl: string) {}
  async assignmentDetails(courseId: number, assignmentId: number): Promise<OnqDetails> {
    const versions = [...new Set([this.le, '1.71', '1.68'])];
    const warnings: string[] = [];
    const base = `/d2l/api/le/${this.le}/${courseId}/dropbox/folders`;
    const folders = await this.client.get<Array<{ Id: number }>>(`${base}/`);
    const folder = folders.find(f => f.Id === assignmentId);
    if (!folder) throw new Error('Assignment is not available in this course.');
    const rubrics: unknown[] = [];
    try {
      const associations = await this.client.get<Array<{ RubricId: number; IsHidden?: boolean; Name?: string }>>(`${base}/${assignmentId}/rubrics/`);
      for (const association of associations.filter(a => !a.IsHidden)) {
        let found = false;
        for (const version of versions) {
          try {
            rubrics.push(await this.client.get(`/d2l/api/le/${version}/${courseId}/rubrics/${association.RubricId}/`));
            found = true; break;
          } catch (err) {
            if (!(err && typeof err === 'object' && 'status' in err && err.status === 404)) break;
          }
        }
        if (!found) warnings.push(`Rubric ${association.RubricId} details unavailable.`);
      }
    } catch { warnings.push('Rubric associations unavailable; this does not mean no rubric exists.'); }
    return { courseId, assignmentId, folder, rubrics, warnings,
      url: `${this.baseUrl}/d2l/lms/dropbox/user/folder_submit_files.d2l?db=${assignmentId}&ou=${courseId}`,
      retrievedAt: new Date().toISOString() };
  }
  async contentCompletions(courseId: number): Promise<OnqCompletions> {
    try {
      // The no-argument /completions/ route is a staff-oriented CSV lookup.
      // /mycount/ is explicitly scoped to the calling student.
      const result = await this.client.get<{ Objects?: unknown[]; Next?: string | null; PagingInfo?: { HasMoreItems?: boolean } }>(`/d2l/api/le/${this.le}/${courseId}/content/completions/mycount/`);
      if (!Array.isArray(result.Objects) || result.Objects.length === 0 || !result.Objects.every(item => item && typeof item === 'object' &&
          typeof (item as { RequiredItems?: unknown }).RequiredItems === 'number' &&
          typeof (item as { CompletedItems?: unknown }).CompletedItems === 'number')) {
        throw new Error('Unsupported completion response shape');
      }
      const partial = result.PagingInfo?.HasMoreItems === true || Boolean(result.Next);
      return { courseId, status: partial ? 'partial' : 'available', completions: result.Objects,
        warnings: partial ? ['More completion pages exist; this is an incomplete result.'] : [],
        retrievedAt: new Date().toISOString() };
    } catch (err) {
      const reason = err instanceof D2lApiError
        ? err.status === 403 ? 'forbidden' : err.status === 404 ? 'not_found' : err.status === 401 ? 'expired_auth' : 'unavailable'
        : 'unsupported';
      return { courseId, status: 'unavailable', completions: null, reason,
        warnings: ['Completion status unavailable; do not infer zero progress or mark topics incomplete.'],
        retrievedAt: new Date().toISOString() };
    }
  }
}
