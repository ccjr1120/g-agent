import type {
  ActiveAgentTurn,
  AgentTaskInfo,
  ConversationTurn,
  McpServerCatalogEntry,
  ScheduledTaskInfo,
  ScheduledTaskRun,
  ServerMessage,
} from "@g-agent/shared";
import type { ChatLine, PlanDisplay, TurnSegment } from "../model.js";

export type TurnStatus = "idle" | "active" | "tool_running" | "asking";

export type EventHandlerContext = {
  streaming: () => ChatLine | null;
  sessionKey: () => string;
  activeSlot: () => number | undefined;
  turnStatus: () => TurnStatus;
  setIsReady: (v: boolean) => void;
  setCatalog: (key: "agents" | "skills" | "mcp", value: unknown) => void;
  setActiveAgent: (v: string) => void;
  setActiveModel: (v: string) => void;
  setSessionAgent: (v: string) => void;
  setSessionModel: (v: string) => void;
  setContext: (v: { usedTokens: number; maxTokens: number; percent: number }) => void;
  setSessionStarted: (v: boolean) => void;
  setTurnStatus: (v: TurnStatus) => void;
  setAgentTasks: (v: AgentTaskInfo[]) => void;
  setScheduledTasks: (v: ScheduledTaskInfo[]) => void;
  setPlans: (key: string, plan: PlanDisplay | undefined) => void;
  dequeueFirstQueued: () => void;
  pushStreamingLine: () => ChatLine;
  handleThinkingDelta: (text: string) => void;
  handleDelta: (text: string) => void;
  handleToolCall: (name: string, args: string) => void;
  handleToolResult: (name: string, output: string) => void;
  handleAskUserEvent: (id: string, question: string, options?: string[]) => void;
  finishActiveTurn: () => void;
  finishTurnWithError: (message: string) => void;
  flushPendingOpen: () => void;
  handleAgentSession: (event: Extract<ServerMessage, { type: "agent_session" }>) => void;
  updateScheduledTask: (task: ScheduledTaskInfo) => void;
  showScheduledHistory: (id: string, runs: ScheduledTaskRun[]) => void;
  pushStatus: (text: string) => void;
  pushAssistantSummary: (text: string) => void;
};

export type { ActiveAgentTurn, ConversationTurn, McpServerCatalogEntry, TurnSegment };
