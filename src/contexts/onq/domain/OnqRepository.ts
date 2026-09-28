export interface OnqDetails {
  courseId: number; assignmentId: number; folder: unknown;
  rubrics: unknown[]; warnings: string[]; url: string; retrievedAt: string;
}
export interface OnqCompletions {
  courseId: number; completions: unknown[]; warnings: string[]; retrievedAt: string;
}
export interface OnqRepository {
  assignmentDetails(courseId: number, assignmentId: number): Promise<OnqDetails>;
  contentCompletions(courseId: number): Promise<OnqCompletions>;
}
