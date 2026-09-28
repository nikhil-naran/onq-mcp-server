import { D2lApiError } from '@/contexts/http-api/errors.js';

/** Keep tenant paths and error bodies out of ordinary tool responses. */
export function accessResult(err: unknown, section: string, courseId: number) {
  const httpStatus = err instanceof D2lApiError ? err.status : undefined;
  const errorCode = httpStatus === 403 ? 'forbidden' : httpStatus === 404 ? 'not_found'
    : httpStatus === 401 ? 'expired_auth' : 'unavailable';
  const message = httpStatus === 403 ? `OnQ does not permit ${section} for this course.`
    : httpStatus === 404 ? `${section} is not available in this course.`
      : httpStatus === 401 ? 'Your OnQ sign-in has expired.' : `${section} could not be read.`;
  return {
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { status: 'unavailable', error_code: errorCode, course_id: courseId,
      section, reason: message, ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
      retrieved_at: new Date().toISOString() },
  };
}
