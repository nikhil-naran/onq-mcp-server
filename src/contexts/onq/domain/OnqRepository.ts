export interface OnqDetails {
  courseId: number; assignmentId: number; folder: unknown;
  rubrics: unknown[]; warnings: string[]; url: string; retrievedAt: string;
}
export interface OnqCompletions {
  courseId: number; status: 'available' | 'partial' | 'unavailable';
  completions: unknown[] | null; reason?: string; warnings: string[]; retrievedAt: string;
}
export interface OnqRepository {
  assignmentDetails(courseId: number, assignmentId: number): Promise<OnqDetails>;
  contentCompletions(courseId: number): Promise<OnqCompletions>;
}
