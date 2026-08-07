import { For, Show, type JSX } from "solid-js";
import { useTheme } from "../context/theme.js";
import { useLocal, type PanelFocus } from "../context/local.js";
import { useSync } from "../persistence.js";
import { formatMmss, truncateToWidth } from "../transcript.js";
import type { Style } from "../theme/index.js";

const MAX_PLAN_VISIBLE = 5;

export function Panels() {
  const sync = useSync();
  const local = useLocal();
  const theme = useTheme();
  const t = theme.theme;
  const focus = local.panelFocus;

  const border = (panel: PanelFocus): Style => (focus() === panel ? t().brand : t().border);

  const plan = () => sync.plans[sync.sessionKey()];
  const planVisible = () => {
    const p = plan();
    if (!p || p.steps.length === 0) return false;
    return !p.steps.every((s) => s.state === "done");
  };

  return (
    <box flexDirection="column">
      <Show when={planVisible()}>
        <PanelBox title=" Plan " color={border("plan")}>
          <PlanContent plan={plan} />
        </PanelBox>
      </Show>
      <Show when={sync.scheduledTasks().length > 0}>
        <PanelBox title=" Scheduled Tasks " color={border("scheduled")}>
          <ScheduledContent scroll={local.scheduledScroll()} />
        </PanelBox>
      </Show>
      <Show when={sync.agentTasks().length > 0}>
        <PanelBox title=" Sub Agents " color={border("subagents")}>
          <SubAgentsContent scroll={local.taskScroll()} />
        </PanelBox>
      </Show>
    </box>
  );
}

function PanelBox(props: { title: string; color: Style; children: JSX.Element }) {
  return (
    <box border borderColor={props.color.fg} title={props.title} titleColor={props.color.fg} flexDirection="column">
      {props.children}
    </box>
  );
}

function StateGlyph(props: { state: "done" | "running" | "pending" | "failed" }) {
  const theme = useTheme();
  const t = theme.theme;
  const glyph = () =>
    props.state === "done" ? "✓" : props.state === "running" ? "●" : props.state === "failed" ? "✗" : "○";
  const style = (): Style =>
    props.state === "done"
      ? t().success
      : props.state === "running"
        ? t().brand
        : props.state === "failed"
          ? t().error
          : t().muted;
  return <text style={style()}>{glyph()}</text>;
}

function PlanContent(props: {
  plan: () => { title: string; steps: Array<{ description: string; state: "done" | "running" | "pending" | "failed" }> } | undefined;
}) {
  const theme = useTheme();
  const t = theme.theme;
  const steps = () => props.plan()?.steps ?? [];

  const visibleSteps = () => {
    const all = steps();
    if (all.length <= MAX_PLAN_VISIBLE) return all;
    const runningIdx = Math.max(0, all.findIndex((s) => s.state === "running"));
    const start = Math.max(0, Math.min(runningIdx - Math.floor(MAX_PLAN_VISIBLE / 2), all.length - MAX_PLAN_VISIBLE));
    return all.slice(start, start + MAX_PLAN_VISIBLE);
  };

  return (
    <>
      <text style={t().muted}>{props.plan()?.title ?? ""}</text>
      <For each={visibleSteps()}>
        {(step) => (
          <box flexDirection="row" height={1}>
            <StateGlyph state={step.state} />
            <text style={t().muted}>{` ${step.description}`}</text>
          </box>
        )}
      </For>
    </>
  );
}

function ScheduledContent(props: { scroll: number }) {
  const sync = useSync();
  const theme = useTheme();
  const t = theme.theme;
  const tasks = () => sync.scheduledTasks().slice(props.scroll);

  return (
    <For each={tasks()}>
      {(task) => (
        <box flexDirection="row" height={1}>
          <text style={task.running ? t().brand : t().muted}>
            {task.running ? "●" : task.lastStatus === "ok" ? "✓" : task.lastStatus === "error" ? "✗" : "○"}
          </text>
          <text style={t().muted}>{` ${task.label}`}</text>
          <text style={t().timing}>
            {` · ${task.running ? "running" : task.lastSummary ? task.lastSummary : nextRun(task.nextRunAt)}`}
          </text>
        </box>
      )}
    </For>
  );
}

function nextRun(nextRunAt: number): string {
  const delta = nextRunAt - Date.now();
  if (delta < 0) return "due";
  return `${Math.max(1, Math.round(delta / 60_000))}m`;
}

function SubAgentsContent(props: { scroll: number }) {
  const sync = useSync();
  const theme = useTheme();
  const t = theme.theme;
  const tasks = () => sync.agentTasks().slice(props.scroll);

  return (
    <For each={tasks()}>
      {(task) => (
        <box flexDirection="column">
          <text style={t().muted}>{`/${task.slot} ${truncateToWidth(task.title, 48)}`}</text>
          <text style={t().muted}>
            {`   ${task.status}${task.activity ? " · " + task.activity : ""} · ${formatMmss(task.elapsedMs)}${task.unread ? " · unread" : ""}`}
          </text>
        </box>
      )}
    </For>
  );
}
