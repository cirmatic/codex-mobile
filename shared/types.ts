export type Item = {
  id: string;
  type: string;
  text?: string;
  content?: { type: string; text?: string }[];
  command?: string;
  aggregatedOutput?: string;
  status?: string;
  exitCode?: number | null;
  changes?: { path: string; kind: unknown; diff: string }[];
  [key: string]: unknown;
};
export type Approval = { id: string | number; method: string; params: Record<string, any> };
export type ThreadState = {
  id: string;
  cwd: string;
  title: string;
  model?: string;
  effort?: string;
  items: Item[];
  activeTurnId: string | null;
  status: string;
  error?: string;
  approvals: Approval[];
};
export type ThreadSummary = Pick<ThreadState, 'id' | 'cwd' | 'title'> & {
  updatedAt?: number;
  status?: string;
};
export type ModelOption = {
  id: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string; description?: string }[];
  inputModalities?: string[];
};
export type Envelope = {
  id?: string;
  action?: string;
  params?: any;
  result?: any;
  error?: string;
  event?: string;
  data?: any;
};
