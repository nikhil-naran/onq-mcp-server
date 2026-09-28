import type { OnqRepository } from '../domain/OnqRepository.js';
export const readAssignmentDetails = (repo: OnqRepository, courseId: number, assignmentId: number) => repo.assignmentDetails(courseId, assignmentId);
export const readContentCompletions = (repo: OnqRepository, courseId: number) => repo.contentCompletions(courseId);
