export function createQuestionHistory(readHistory: (method: string, params: { threadId: string; [key: string]: unknown }) => Promise<unknown>):
  (method: string, params: { threadId?: string }, result: unknown) => Promise<unknown>;
