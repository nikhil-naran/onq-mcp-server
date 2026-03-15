/**
 * api.ts
 * Typed D2L REST API client for ONQ (Queen's University Brightspace).
 *
 * Authentication: passes the session cookies obtained by auth.ts as a
 * Cookie HTTP header.  This works because D2L's REST endpoints accept
 * the same browser session that the front-end uses.
 *
 * API reference: https://docs.valence.desire2learn.com/reference.html
 */

import axios, { type AxiosError } from 'axios';
import type { Cookie } from 'playwright';
import { ONQ_HOST, LP_VERSION, LE_VERSION } from './config.js';
import { cookiesToHeader } from './auth.js';

// ─── Custom error ─────────────────────────────────────────────────────────────

export class ONQApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ONQApiError';
  }
}

// ─── D2L response types ───────────────────────────────────────────────────────

export interface WhoAmI {
  Identifier: string;
  FirstName: string;
  LastName: string;
  UniqueName: string;   // NetID
  ProfileIdentifier: string;
}

export interface OrgUnit {
  Id: number;
  Type: { Id: number; Code: string; Name: string };
  Name: string;
  Code: string;
  IsActive: boolean;
  StartDate: string | null;
  EndDate: string | null;
}

export interface EnrollmentItem {
  OrgUnit: OrgUnit;
  Access: { ClasslistRoleName: string };
}

export interface EnrollmentResponse {
  Items: EnrollmentItem[];
  PagingInfo: { Bookmark: string; HasMoreItems: boolean };
}

export interface RichText { Text: string; Html: string }

/** A file attached directly to a dropbox folder (e.g. a PDF of assignment instructions). */
export interface DropboxAttachment {
  /**
   * Numeric file identifier — the correct parameter for the download URL:
   *   GET /d2l/api/le/{ver}/{courseId}/dropbox/folders/{folderId}/attachments/{FileId}
   * FileSystemLocator is an internal D2L path string and is NOT accepted by the API.
   */
  FileId?: number | null;
  /** Internal D2L file-system path (NOT usable as a download URL parameter). */
  FileSystemLocator: string;
  FileName: string;
  Size: number;
}

export interface DropboxFolder {
  Id: number;
  Name: string;
  // D2L uses different field names across versions — check all of them
  Instructions?: RichText | null;
  CustomInstructions?: RichText | null;
  Description?: RichText | null;
  DueDate: string | null;
  EndDate: string | null;
  IsHidden: boolean;
  IsDeleted: boolean;
  CategoryId: number | null;
  Score: { HasMandatoryScore: boolean; MaxScore: number | null } | null;
  Availability: { StartDate: string | null; EndDate: string | null } | null;
  /** Files attached directly to this folder (e.g. the PDF of assignment instructions). */
  Attachments?: DropboxAttachment[] | null;
}

// ─── Rubric types ─────────────────────────────────────────────────────────────

export interface RubricLevel {
  Id: number;
  Name: string;
  Points: number | null;
}

export interface RubricCriterion {
  Id: number;
  Name: string;
  Description?: RichText | null;
  OutOf?: number | null;
  Levels: Array<{
    Id: number;
    Name: string;
    Points?: number | null;
    Description?: RichText | null;
  }>;
}

export interface RubricDetail {
  RubricId: number;
  Name: string;
  Description?: RichText | null;
  Levels?: RubricLevel[];
  Criteria?: RubricCriterion[];
}

export interface RubricAssociation {
  RubricId: number;
  Name: string;
  IsHidden?: boolean;
}

export interface GradeValue {
  GradeObjectIdentifier: string;
  GradeObjectName: string;
  GradeObjectType: number;
  GradeObjectTypeName: string;
  DisplayedGrade: string;
  PointsNumerator: number | null;
  PointsDenominator: number | null;
  WeightedNumerator: number | null;
  WeightedDenominator: number | null;
}

// The D2L myGradeValues endpoint returns a plain JSON array, not a wrapped object.
export type GradeValueCollection = GradeValue[];

export interface NewsItemAttachment {
  FileId: number;
  FileName: string;
  Size: number;
}

export interface NewsItem {
  Id: number;
  Title: string;
  StartDate: string;
  EndDate: string | null;
  IsHidden: boolean;
  IsPublished: boolean;
  Body: { Text: string; Html: string };
  /** Files attached to this announcement (populated on detail fetch). */
  Attachments?: NewsItemAttachment[] | null;
}

export interface ContentTopic {
  Id: number;
  Title: string;
  ShortTitle: string;
  Type: number;
  TypeIdentifier: string;
  Url: string | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
}

export interface ContentModule {
  Id: number;
  Title: string;
  ShortTitle: string;
  Type: number;
  ModuleId?: number;
  LastModifiedDate: string;
  IsHidden: boolean;
  IsLocked: boolean;
  Structure: ContentTopic[];
  Modules: ContentModule[];
}

export interface ApiVersion {
  ProductCode: string;
  LatestVersion: string;
  SupportedVersions: string[];
}

// ─── Content TOC types ────────────────────────────────────────────────────────

export interface TocTopic {
  TopicId: number;
  Identifier: string;
  Title: string;
  ShortTitle: string;
  Type: number;
  TypeIdentifier: string;
  Url: string | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
  OpenNewWindow: boolean;
  ActivityId: string | null;
}

export interface TocModule {
  ModuleId: number;
  Title: string;
  ShortTitle: string;
  Type: number;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
  LastModifiedDate: string;
  Topics: TocTopic[];
  Modules: TocModule[];
}

export interface ContentToc {
  Modules: TocModule[];
}

export interface TopicBody {
  TopicId: number;
  Title: string;
  ShortTitle: string;
  Type: number;
  TypeIdentifier: string;
  Url: string | null;
  StartDate: string | null;
  EndDate: string | null;
  DueDate: string | null;
  IsHidden: boolean;
  IsLocked: boolean;
  // For HTML/text topics, the body is here
  Body?: { Text: string; Html: string } | null;
  // For file topics, the file URL is in Url
}

// ─── Gap 4: Submission status types ──────────────────────────────────────────

export type EntityDropboxStatus = 'Unsubmitted' | 'Submitted' | 'Draft' | 'Published';

export interface DropboxSubmissionFile {
  FileId: number;
  FileName: string;
  Size: number;
}

export interface DropboxSubmission {
  SubmissionId: number;
  SubmittedDate: string;
  Comment: string | null;
  Files: DropboxSubmissionFile[];
}

export interface EntityDropboxFeedback {
  Score: number | null;
  OutOf: number | null;
  Feedback: { Text: string; Html: string } | null;
}

export interface EntityDropbox {
  Status: EntityDropboxStatus;
  CompletionDate: string | null;
  Feedback: EntityDropboxFeedback | null;
  Submissions: DropboxSubmission[];
}

// ─── Gap 9: Content completion types ─────────────────────────────────────────

export interface ContentCompletionData {
  CompletionId: number;
  OrgUnitId: number;
  TopicId: number;
  IsComplete: boolean;
  LastVisited: string | null;
}

export interface ContentCompletionCollection {
  TotalCount: number;
  Objects: ContentCompletionData[];
}

// ─── Gap 11: Calendar event types ────────────────────────────────────────────

export interface CalendarEvent {
  CalendarEventId: number;
  Title: string;
  Description: { Html: string; Text: string } | null;
  StartDateTime: string;
  EndDateTime: string | null;
  IsAllDayEvent: boolean;
  Location: string | null;
  AssociatedEntity: {
    TypeIdentifier: string;
    EntityId: number | null;
  } | null;
}

export interface CalendarEventCollection {
  Objects: CalendarEvent[];
}

// ─── Gap 6: Quiz types ────────────────────────────────────────────────────────

export interface Quiz {
  QuizId: number;
  Name: string;
  DueDate: string | null;
  StartDate: string | null;
  EndDate: string | null;
  IsActive: boolean;
  Attempts: { IsUnlimited: boolean; NumberOfAttemptsAllowed: number | null } | null;
}

export interface QuizAttemptScore {
  GotBonus: boolean;
  ScoreGiven: number | null;
  ScoreDenominator: number | null;
}

export interface QuizAttempt {
  AttemptId: number;
  UserId: number;
  AttemptNumber: number;
  CompletionStatusTypeName: string;
  TimeStarted: string;
  Score: QuizAttemptScore | null;
}

// ─── Gap 8: Discussion types ──────────────────────────────────────────────────

export interface DiscussionForum {
  ForumId: number;
  Name: string;
  Description: { Html: string; Text: string } | null;
  IsHidden: boolean;
}

export interface DiscussionTopic {
  TopicId: number;
  ForumId: number;
  Name: string;
  Description: { Html: string; Text: string } | null;
  IsHidden: boolean;
  DueDate: string | null;
}

export interface DiscussionPostPoster {
  Identifier: string;
  DisplayName: string;
}

export interface DiscussionPost {
  PostId: number;
  TopicId: number;
  Subject: string;
  Message: { Html: string; Text: string } | null;
  DatePosted: string;
  ParentPostId: number | null;
  Poster: DiscussionPostPoster;
}

export interface DiscussionPostCollection {
  Objects: DiscussionPost[];
  Next: string | null;
}

// ─── API Client ───────────────────────────────────────────────────────────────

export class ONQApiClient {
  private readonly cookieHeader: string;

  constructor(cookies: Cookie[]) {
    this.cookieHeader = cookiesToHeader(cookies);
  }

  // ── Core HTTP helper ──────────────────────────────────────────────────────

  // Gap 7: Retries up to 3 times on HTTP 429 (rate limit) with exponential backoff.
  private async get<T>(url: string): Promise<T> {
    const MAX_RETRIES = 3;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios.get<T>(url, {
          headers: {
            Cookie: this.cookieHeader,
            Accept: 'application/json',
            // D2L checks this header to distinguish API calls from browser nav
            'X-Requested-With': 'XMLHttpRequest',
          },
          // Don't throw for 4xx so we can give better error messages
          validateStatus: (s) => s < 500,
        });

        // Rate limit — back off and retry
        if (response.status === 429) {
          if (attempt < MAX_RETRIES) {
            const retryAfterSec = parseInt(
              String(response.headers['retry-after'] ?? ''), 10
            );
            const delayMs = isNaN(retryAfterSec)
              ? Math.pow(2, attempt) * 1000   // exponential backoff: 1s, 2s, 4s
              : retryAfterSec * 1000;
            await new Promise((r) => setTimeout(r, Math.min(delayMs, 30_000)));
            continue;
          }
          throw new ONQApiError(
            429,
            'D2L API rate limit exceeded after retries. Wait a moment and try again.'
          );
        }

        if (response.status === 401 || response.status === 403) {
          throw new ONQApiError(
            response.status,
            'Session expired or access denied. Please log out and log in again.'
          );
        }

        if (response.status === 404) {
          throw new ONQApiError(
            404,
            `Endpoint not found: ${url}\n` +
            'This may mean the D2L API version is wrong for this ONQ instance.\n' +
            'Try adjusting ONQ_LP_VERSION / ONQ_LE_VERSION environment variables.'
          );
        }

        if (response.status !== 200) {
          throw new ONQApiError(response.status, `Unexpected response ${response.status} from ${url}`);
        }

        return response.data;
      } catch (err) {
        if (err instanceof ONQApiError) throw err;
        const axiosErr = err as AxiosError;
        throw new ONQApiError(
          axiosErr.response?.status ?? 0,
          `Network error: ${axiosErr.message}`
        );
      }
    }

    // Should never reach here — the loop always returns or throws
    throw new ONQApiError(0, 'Unexpected error in get()');
  }

  // ── API Methods ───────────────────────────────────────────────────────────

  /** Get the currently authenticated user's info. Also used to validate the session. */
  whoAmI(): Promise<WhoAmI> {
    return this.get<WhoAmI>(`${ONQ_HOST}/d2l/api/lp/${LP_VERSION}/users/whoami`);
  }

  /**
   * Get all courses the user is enrolled in.
   * orgUnitTypeId=3 means "course offering" — what students see in their course list.
   */
  getEnrollments(orgUnitTypeId = 3): Promise<EnrollmentResponse> {
    return this.get<EnrollmentResponse>(
      `${ONQ_HOST}/d2l/api/lp/${LP_VERSION}/enrollments/myenrollments/` +
      `?orgUnitTypeId=${orgUnitTypeId}&pageSize=100`
    );
  }

  /** List all assignment dropbox folders for a course. */
  getAssignments(courseId: number): Promise<DropboxFolder[]> {
    return this.get<DropboxFolder[]>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/dropbox/folders/`
    );
  }

  /**
   * Get the full details (including instructions/rubric HTML) for a single assignment.
   * Tries several URL forms and LE versions since D2L is inconsistent about trailing slashes
   * and some versions expose this endpoint differently.
   */
  async getAssignmentDetails(courseId: number, folderId: number): Promise<DropboxFolder> {
    // Candidates to try in order: no trailing slash first (most common), then with slash,
    // then older LE versions in case 1.92 doesn't support the single-item endpoint.
    const candidates: string[] = [
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/dropbox/folders/${folderId}`,
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/dropbox/folders/${folderId}/`,
      `${ONQ_HOST}/d2l/api/le/1.71/${courseId}/dropbox/folders/${folderId}`,
      `${ONQ_HOST}/d2l/api/le/1.68/${courseId}/dropbox/folders/${folderId}`,
      `${ONQ_HOST}/d2l/api/le/1.51/${courseId}/dropbox/folders/${folderId}`,
    ];

    let lastErr: unknown;
    for (const url of candidates) {
      try {
        return await this.get<DropboxFolder>(url);
      } catch (err) {
        if (err instanceof ONQApiError && err.status === 404) {
          lastErr = err;
          continue; // try next candidate
        }
        throw err; // non-404 errors propagate immediately
      }
    }

    // All versioned endpoints 404'd — fall back to the list and find by ID.
    // The list response includes Instructions for most D2L configurations.
    const all = await this.getAssignments(courseId);
    const match = all.find((f) => f.Id === folderId);
    if (match) return match;

    throw lastErr; // nothing worked
  }

  /**
   * Download a file attached directly to a dropbox folder.
   *
   * D2L API endpoint:
   *   GET /d2l/api/le/{ver}/{courseId}/dropbox/folders/{folderId}/attachments/{FileId}
   *
   * The path parameter is the numeric `FileId` from `DropboxAttachment`, NOT the
   * `FileSystemLocator` string (which is an internal D2L storage path and is rejected
   * by the API router if used directly).
   *
   * Falls back to URL-encoded `FileSystemLocator` in case a D2L instance returns
   * `FileId` as null/undefined and only exposes the locator.
   */
  async downloadDropboxAttachment(
    courseId: number,
    folderId: number,
    attachment: { FileId?: number | null; FileSystemLocator: string },
  ): Promise<{ contentType: string; buffer: Buffer }> {
    const base = (ver: string) =>
      `${ONQ_HOST}/d2l/api/le/${ver}/${courseId}/dropbox/folders/${folderId}/attachments`;

    // Build candidate URLs. Primary form uses the numeric FileId (correct per D2L docs).
    // Fallback uses the URL-encoded FileSystemLocator in case FileId is absent.
    const candidates: string[] = [];
    if (attachment.FileId != null) {
      candidates.push(
        `${base(LE_VERSION)}/${attachment.FileId}`,
        `${base('1.71')}/${attachment.FileId}`,
        `${base('1.68')}/${attachment.FileId}`,
      );
    }
    if (attachment.FileSystemLocator) {
      const enc = encodeURIComponent(attachment.FileSystemLocator);
      candidates.push(
        `${base(LE_VERSION)}/${enc}`,
        `${base('1.71')}/${enc}`,
      );
    }

    let lastErr: unknown;
    for (const url of candidates) {
      let response: Awaited<ReturnType<typeof axios.get<ArrayBuffer>>>;
      try {
        response = await axios.get<ArrayBuffer>(url, {
          headers: { Cookie: this.cookieHeader, Accept: '*/*' },
          responseType: 'arraybuffer',
          maxRedirects: 10,
          validateStatus: () => true, // handle all status codes ourselves
        });
      } catch (err) {
        lastErr = err;
        continue;
      }

      const { status } = response;
      const ct = String(response.headers['content-type'] ?? '');

      // Hard failures — don't retry
      if (status === 401 || status === 403) {
        throw new ONQApiError(status, 'Access denied fetching attachment.');
      }

      // If D2L returned a problem+json or JSON error body, extract the detail message
      // so we can surface it rather than returning the JSON bytes as if they were a file.
      if (ct.includes('problem+json') || (ct.includes('application/json') && status >= 400)) {
        let detail = `HTTP ${status}`;
        try {
          const parsed = JSON.parse(Buffer.from(response.data).toString('utf-8')) as Record<string, unknown>;
          detail = String(parsed['detail'] ?? parsed['title'] ?? parsed['message'] ?? detail);
        } catch { /* ignore parse errors */ }
        lastErr = new ONQApiError(status >= 400 ? status : 400, `D2L rejected attachment request: ${detail}`);
        continue; // try next URL candidate
      }

      // Any non-2xx is a failure for this candidate — try next
      if (status < 200 || status >= 300) {
        lastErr = new ONQApiError(status, `Unexpected HTTP ${status} fetching attachment`);
        continue;
      }

      // Success
      return {
        contentType: ct || 'application/octet-stream',
        buffer: Buffer.from(response.data),
      };
    }
    const id = attachment.FileId ?? attachment.FileSystemLocator;
    throw lastErr ?? new ONQApiError(404, `Attachment not found: ${id}`);
  }

  /** Get the current user's grade values for a course. */
  getGrades(courseId: number): Promise<GradeValue[]> {
    return this.get<GradeValue[]>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/grades/values/myGradeValues/`
    );
  }

  /** Get grades using an explicit API version string (used for version fallback). */
  getGradesWithVersion(courseId: number, leVersion: string): Promise<GradeValue[]> {
    return this.get<GradeValue[]>(
      `${ONQ_HOST}/d2l/api/le/${leVersion}/${courseId}/grades/values/myGradeValues/`
    );
  }

  /** Get course news / announcements. */
  getAnnouncements(courseId: number): Promise<NewsItem[]> {
    return this.get<NewsItem[]>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/news/`
    );
  }

  /** Get the root content module tree for a course. */
  getCourseContent(courseId: number): Promise<ContentModule> {
    return this.get<ContentModule>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/content/root/`
    );
  }

  /**
   * Get the full content table of contents for a course in one call.
   * Returns all modules and topics recursively — much better than /root/.
   */
  getContentToc(courseId: number): Promise<ContentToc> {
    return this.get<ContentToc>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/content/toc`
    );
  }

  /**
   * Get the structure (topics) of a specific content module.
   * Useful as a fallback when the TOC endpoint isn't available.
   */
  getModuleStructure(courseId: number, moduleId: number): Promise<ContentModule> {
    return this.get<ContentModule>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/content/modules/${moduleId}/structure/`
    );
  }

  /**
   * Get the full content/body of a specific topic (file, HTML page, etc.).
   * Returns the topic metadata plus HTML body text where available.
   */
  getTopicContent(courseId: number, topicId: number): Promise<TopicBody> {
    return this.get<TopicBody>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/content/topics/${topicId}`
    );
  }

  /**
   * Download the raw file bytes for a topic (PDF, HTML page, video, etc.).
   * Uses the D2L /file endpoint which follows redirects to the actual content.
   * Returns the buffer plus the content-type header so the caller can decide
   * how to parse the data (pdf-parse for PDFs, toString for HTML, etc.).
   */
  async fetchTopicFile(
    courseId: number,
    topicId: number
  ): Promise<{ contentType: string; buffer: Buffer }> {
    const url =
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/content/topics/${topicId}/file`;
    const response = await axios.get<ArrayBuffer>(url, {
      headers: {
        Cookie: this.cookieHeader,
        Accept: '*/*',
      },
      responseType: 'arraybuffer',
      maxRedirects: 10,
      // Don't throw on 4xx so we can give a better error
      validateStatus: (s) => s < 500,
    });

    if (response.status === 401 || response.status === 403) {
      throw new ONQApiError(response.status, 'Access denied fetching topic file.');
    }
    if (response.status === 404) {
      throw new ONQApiError(404, `Topic file not found (topic ${topicId}).`);
    }

    return {
      contentType: String(
        response.headers['content-type'] ?? 'application/octet-stream'
      ),
      buffer: Buffer.from(response.data),
    };
  }

  /**
   * Get the rubric associations for a dropbox folder.
   * Returns minimal rubric metadata (IDs + names).
   */
  getDropboxRubrics(courseId: number, folderId: number): Promise<RubricAssociation[]> {
    return this.get<RubricAssociation[]>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/dropbox/folders/${folderId}/rubrics/`
    );
  }

  /**
   * Get full rubric details (criteria + levels) for a single rubric.
   * Falls back across LE versions because the rubrics endpoint moved between versions.
   */
  async getRubricDetail(courseId: number, rubricId: number): Promise<RubricDetail> {
    const candidates = [
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/rubrics/${rubricId}/`,
      `${ONQ_HOST}/d2l/api/le/1.71/${courseId}/rubrics/${rubricId}/`,
      `${ONQ_HOST}/d2l/api/le/1.68/${courseId}/rubrics/${rubricId}/`,
    ];
    for (const url of candidates) {
      try { return await this.get<RubricDetail>(url); } catch (e) {
        if (e instanceof ONQApiError && e.status === 404) continue;
        throw e;
      }
    }
    throw new ONQApiError(404, `Rubric ${rubricId} not found.`);
  }

  /**
   * Get the full body of a single news/announcement item.
   * The list endpoint truncates the body; this returns the complete text.
   */
  getAnnouncementDetail(courseId: number, newsItemId: number): Promise<NewsItem> {
    return this.get<NewsItem>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/news/${newsItemId}/`
    );
  }

  /**
   * Discover which API versions ONQ supports.
   * Useful for debugging version mismatches — no auth needed.
   */
  getSupportedVersions(): Promise<ApiVersion[]> {
    return this.get<ApiVersion[]>(`${ONQ_HOST}/d2l/api/versions/`);
  }

  // ─── Gap 4: Submission status ────────────────────────────────────────────────

  /**
   * Get the current user's own submissions for a specific dropbox folder.
   * Returns submission status (Unsubmitted/Submitted/Draft/Published), submission
   * files, timestamps, and any published feedback/score.
   */
  getMySubmissions(courseId: number, folderId: number): Promise<EntityDropbox[]> {
    return this.get<EntityDropbox[]>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/dropbox/folders/${folderId}/submissions/mysubmissions/`
    );
  }

  // ─── Gap 9: Content completions ──────────────────────────────────────────────

  /**
   * Get which content topics the current user has completed/visited.
   * Returns a collection with an Objects array of ContentCompletionData records.
   * Falls back to an empty collection if the endpoint isn't available.
   */
  async getContentCompletions(courseId: number): Promise<ContentCompletionCollection> {
    try {
      return await this.get<ContentCompletionCollection>(
        `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/content/completions/`
      );
    } catch (err) {
      if (err instanceof ONQApiError && (err.status === 404 || err.status === 403)) {
        return { TotalCount: 0, Objects: [] };
      }
      throw err;
    }
  }

  // ─── Gap 11: Calendar events ──────────────────────────────────────────────────

  /**
   * Get calendar events for a specific course.
   * D2L endpoint: GET /d2l/api/le/{ver}/{orgUnitId}/calendar/events/
   */
  async getCalendarEvents(courseId: number): Promise<CalendarEvent[]> {
    // D2L may return either an array directly or a paged collection object
    const raw = await this.get<CalendarEvent[] | CalendarEventCollection>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/calendar/events/`
    );
    if (Array.isArray(raw)) return raw;
    return (raw as CalendarEventCollection).Objects ?? [];
  }

  // ─── Gap 6: Quizzes ───────────────────────────────────────────────────────────

  /** List all quizzes for a course. */
  getQuizzes(courseId: number): Promise<Quiz[]> {
    return this.get<Quiz[]>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/quizzes/`
    );
  }

  /**
   * Get the current user's own quiz attempts for a specific quiz.
   * D2L endpoint: GET /d2l/api/le/{ver}/{orgUnitId}/quizzes/{quizId}/attempts/myattempts/
   */
  async getMyQuizAttempts(courseId: number, quizId: number): Promise<QuizAttempt[]> {
    const raw = await this.get<QuizAttempt[] | { Objects: QuizAttempt[] }>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/quizzes/${quizId}/attempts/myattempts/`
    );
    if (Array.isArray(raw)) return raw;
    return (raw as { Objects: QuizAttempt[] }).Objects ?? [];
  }

  // ─── Gap 8: Discussions ───────────────────────────────────────────────────────

  /** List all discussion forums for a course. */
  getDiscussionForums(courseId: number): Promise<DiscussionForum[]> {
    return this.get<DiscussionForum[]>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/discussions/forums/`
    );
  }

  /** List all topics within a discussion forum. */
  getDiscussionTopics(courseId: number, forumId: number): Promise<DiscussionTopic[]> {
    return this.get<DiscussionTopic[]>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/discussions/forums/${forumId}/topics/`
    );
  }

  /**
   * Get posts in a discussion topic.
   * Returns both top-level posts and replies.
   */
  async getDiscussionPosts(
    courseId: number,
    forumId: number,
    topicId: number
  ): Promise<DiscussionPost[]> {
    const raw = await this.get<DiscussionPost[] | DiscussionPostCollection>(
      `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/discussions/forums/${forumId}/topics/${topicId}/posts/`
    );
    if (Array.isArray(raw)) return raw;
    return (raw as DiscussionPostCollection).Objects ?? [];
  }

  // ─── Gap 12: Announcement attachments ────────────────────────────────────────

  /**
   * Download a file attached to a course announcement.
   * D2L endpoint: GET /d2l/api/le/{ver}/{orgUnitId}/news/{newsItemId}/attachments/{fileId}
   */
  async downloadNewsAttachment(
    courseId: number,
    newsItemId: number,
    fileId: number
  ): Promise<{ contentType: string; buffer: Buffer }> {
    const url = `${ONQ_HOST}/d2l/api/le/${LE_VERSION}/${courseId}/news/${newsItemId}/attachments/${fileId}`;
    const response = await axios.get<ArrayBuffer>(url, {
      headers: { Cookie: this.cookieHeader, Accept: '*/*' },
      responseType: 'arraybuffer',
      maxRedirects: 10,
      validateStatus: () => true,
    });

    if (response.status === 401 || response.status === 403) {
      throw new ONQApiError(response.status, 'Access denied fetching announcement attachment.');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ONQApiError(response.status, `HTTP ${response.status} fetching attachment ${fileId}.`);
    }

    return {
      contentType: String(response.headers['content-type'] ?? 'application/octet-stream'),
      buffer: Buffer.from(response.data),
    };
  }
}
