import type { ServerMessage } from "@g-agent/shared";
import type { PlanDisplay } from "../model.js";
import { formatPlanMessage } from "./plan.js";
import type { EventHandlerContext } from "./sync-types.js";

export function handleServerEvent(ctx: EventHandlerContext, event: ServerMessage): void {
  switch (event.type) {
    case "ready":
      ctx.setIsReady(true);
      break;
    case "agents":
      ctx.setCatalog("agents", event.agents);
      ctx.setActiveAgent(event.active);
      ctx.setActiveModel(event.model);
      ctx.setSessionAgent(event.active);
      ctx.setSessionModel(event.model);
      break;
    case "skills":
      ctx.setCatalog("skills", event.skills);
      break;
    case "mcp":
      ctx.setCatalog("mcp", event.servers);
      break;
    case "context":
      ctx.setContext({ usedTokens: event.usedTokens, maxTokens: event.maxTokens, percent: event.percent });
      break;
    case "start":
      ctx.setSessionStarted(true);
      ctx.dequeueFirstQueued();
      if (!ctx.streaming()) {
        ctx.pushStreamingLine();
        ctx.setTurnStatus("active");
      }
      break;
    case "thinkingDelta":
      ctx.handleThinkingDelta(event.text);
      break;
    case "delta":
      ctx.handleDelta(event.text);
      break;
    case "tool_call":
      ctx.handleToolCall(event.name, event.args);
      break;
    case "tool_result":
      ctx.handleToolResult(event.name, event.output);
      break;
    case "ask_user":
      ctx.handleAskUserEvent(event.id, event.question, event.options);
      break;
    case "done":
      ctx.finishActiveTurn();
      ctx.setSessionStarted(false);
      ctx.flushPendingOpen();
      break;
    case "error":
      ctx.finishTurnWithError(event.message);
      ctx.flushPendingOpen();
      break;
    case "resumed":
      ctx.setActiveAgent(event.agent);
      break;
    case "agent_session":
      ctx.handleAgentSession(event);
      break;
    case "agent_tasks":
      ctx.setAgentTasks(event.tasks);
      break;
    case "scheduled_tasks":
      ctx.setScheduledTasks(event.tasks);
      break;
    case "scheduled_task_update":
      ctx.updateScheduledTask(event.task);
      break;
    case "scheduled_task_history":
      ctx.showScheduledHistory(event.id, event.runs);
      break;
    case "notice":
      ctx.pushStatus(event.message);
      break;
    case "system_prompt":
      break;
  }
}

export function completePlanIfDone(
  ctx: EventHandlerContext,
  plan: PlanDisplay | null,
  rawArgs: string,
  sessionKey: string,
): void {
  if (!plan) return;
  if (plan.steps.every((s) => s.state === "done")) {
    ctx.setPlans(sessionKey, undefined);
    ctx.pushAssistantSummary(formatPlanMessage(rawArgs));
    return;
  }
  ctx.setPlans(sessionKey, plan);
}
