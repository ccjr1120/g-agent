export type ScheduledTaskStatus =
  | "scheduled"
  | "running"
  | "ok"
  | "error"
  | "cancelled";

export type ScheduledTaskEntry = {
  id: string;
  label: string;
  prompt: string;
  intervalSeconds: number;
  nextRunAt: number;
  running: boolean;
  lastRunAt?: number;
  lastStatus: ScheduledTaskStatus;
  lastSummary?: string;
  unread: boolean;
};

/**
 * Recurring background-task registry owned by the runtime (the server). The
 * agent package only defines the contract: tools schedule/unschedule tasks and
 * the runtime decides how they run and how results reach the TUI.
 */
export type ScheduledTaskManager = {
  schedule(args: {
    label: string;
    prompt: string;
    intervalSeconds: number;
  }): ScheduledTaskEntry;
  unschedule(id: string): { ok: boolean; error?: string };
  list(): ScheduledTaskEntry[];
};
