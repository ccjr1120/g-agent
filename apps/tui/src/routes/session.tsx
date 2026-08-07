import { useTerminalDimensions, useKeyboard } from "@opentui/solid";
import { createSignal, For, Show, onMount, onCleanup } from "solid-js";
import { useTheme } from "../context/theme.js";
import { useSync } from "../persistence.js";
import { useLocal } from "../context/local.js";
import { lineToBlocks, formatMmss, centerLine } from "../transcript.js";
import { applyCollapse, type CollapsedBlock } from "../collapse.js";
import {
  annotateBlocks,
  ASSISTANT_BULLET,
  ASSISTANT_CONTINUATION,
  blankLineContent,
  gapsBeforeBlocks,
  streamingHasBody,
  THINKING_PREFIX,
} from "../transcript-render.js";
import { StatusBar } from "./status-bar.js";
import { Panels } from "./panels.js";
import { Composer } from "./composer.js";
import type { Style } from "../theme/index.js";
import type { ChatLine } from "../model.js";

export function SessionRoute() {
  const dimensions = useTerminalDimensions();
  const sync = useSync();
  const local = useLocal();

  const hasPanels = () =>
    sync.scheduledTasks().length > 0 ||
    sync.agentTasks().length > 0 ||
    (() => {
      const plan = sync.plans[sync.sessionKey()];
      return plan != null && plan.steps.length > 0 && !plan.steps.every((s) => s.state === "done");
    })();

  useKeyboard((event) => {
    if (local.panelFocus() !== "input") return;
    if (event.name === "pageup") {
      local.scrollHistory(3, 9999);
      return;
    }
    if (event.name === "pagedown") {
      local.scrollHistory(-3, 9999);
    }
  });

  const scrollHint = () => {
    const offset = local.historyScroll();
    return offset > 0 ? `History · ${offset} rows below · PageDown to follow` : null;
  };

  return (
    <box
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
      width={dimensions().width}
      height={dimensions().height}
    >
      <TranscriptArea scrollHint={scrollHint()} />
      <Show when={hasPanels()}>
        <box height={1} />
      </Show>
      <Panels />
      <StatusBar />
      <Composer />
    </box>
  );
}

function useClock(): () => number {
  const [clock, setClock] = createSignal(Date.now());
  const sync = useSync();
  const isLive = () =>
    sync.turnStatus() !== "idle" ||
    sync.sessionStarted() ||
    sync.connState() !== "connected" ||
    sync.streaming() !== null;

  onMount(() => {
    const timer = setInterval(() => {
      if (isLive()) setClock(Date.now());
    }, 100);
    onCleanup(() => clearInterval(timer));
  });
  return clock;
}

function TranscriptArea(props: { scrollHint: string | null }) {
  const sync = useSync();
  const local = useLocal();
  const theme = useTheme();
  const dimensions = useTerminalDimensions();
  const clock = useClock();

  const visibleLines = () => sync.lines().filter((line) => !line.queued);

  const isWelcome = () =>
    visibleLines().length === 0 && !sync.streaming() && sync.turnStatus() === "idle";

  const spinnerGap = () => {
    const live = sync.streaming();
    if (live && streamingHasBody(live.segments, live.pendingText, live.pendingThinking)) return true;
    return visibleLines().length > 0;
  };

  return (
    <box flexGrow={1} minHeight={0} flexDirection="column" paddingX={1}>
      <Show when={sync.connState() === "disconnected" || sync.connState() === "reconnecting"}>
        <text style={theme.theme().warning}>
          {sync.connState() === "disconnected"
            ? "! Connection lost — reconnecting…"
            : "! Reconnecting…"}
        </text>
      </Show>
      <Show when={sync.banner().length > 0}>
        <box height={1} />
        <box height={1} />
        <For each={sync.banner()}>
          {(line) => (
            <text style={theme.theme().banner}>{centerLine(line, dimensions().width, 1)}</text>
          )}
        </For>
        <box height={1} />
      </Show>
      <Show when={isWelcome()}>
        <Show
          when={sync.connState() === "connected"}
          fallback={<SpinnerLine status="connecting" clock={clock} startedAt={() => null} />}
        >
          <text style={theme.theme().welcome}>
            {sync.sessionAgent()
              ? `Agent: ${sync.sessionAgent()}. Enter to send, /back to return, / for commands.`
              : "Choose an agent with /agent <name>. Use / for commands."}
          </text>
        </Show>
        <box height={1} />
      </Show>
      <Show when={props.scrollHint}>
        <text style={theme.theme().muted}>{props.scrollHint}</text>
      </Show>
      <For each={visibleLines()}>
        {(line, index) => (
          <box flexDirection="column">
            <Show when={index() > 0}>
              <BlankLine />
            </Show>
            <LineBlocks line={line} expand={local.expandThinking()} />
          </box>
        )}
      </For>
      <Show when={sync.streaming()}>
        {(live) => (
          <box flexDirection="column">
            <Show
              when={
                visibleLines().length > 0 &&
                streamingHasBody(live().segments, live().pendingText, live().pendingThinking)
              }
            >
              <BlankLine />
            </Show>
            <StreamingBlocks line={live()} expand={local.expandThinking()} />
          </box>
        )}
      </Show>
      <For each={sync.queuedLines()}>
        {(line) => (
          <box flexDirection="column">
            <BlankLine />
            <QueuedBlock line={line} />
          </box>
        )}
      </For>
      <Show when={sync.turnStatus() !== "idle"}>
        <Show when={spinnerGap()}>
          <BlankLine />
        </Show>
        <SpinnerLine status={sync.turnStatus()} clock={clock} startedAt={sync.turnStartedAt} />
      </Show>
    </box>
  );
}

function LineBlocks(props: { line: ChatLine; expand: boolean }) {
  const theme = useTheme();
  const t = theme.theme;

  if (props.line.role === "user") {
    return <BlockLine text={props.line.text} prefix="> " style={t().userMessage} />;
  }
  if (props.line.role === "local" || props.line.role === "status") {
    return <BlockLine text={props.line.text} prefix="ℹ " style={t().muted} />;
  }
  if (props.line.role === "error") {
    return <BlockLine text={props.line.text} prefix="! " style={t().error} />;
  }

  const annotated = () => annotateBlocks(applyCollapse(lineToBlocks(props.line), props.expand));
  return (
    <AssistantBlocks annotated={annotated()} />
  );
}

function StreamingBlocks(props: { line: ChatLine; expand: boolean }) {
  const annotated = () => {
    const committed = annotateBlocks(applyCollapse(lineToBlocks(props.line, true), props.expand));
    const blocks: CollapsedBlock[] = [...committed.map((item) => item.block)];
    if (props.line.pendingThinking) {
      blocks.push({ kind: "thinking", text: props.line.pendingThinking });
    }
    if (props.line.pendingText) {
      blocks.push({ kind: "text", text: props.line.pendingText });
    }
    return annotateBlocks(blocks);
  };
  return <AssistantBlocks annotated={annotated()} />;
}

function AssistantBlocks(props: { annotated: ReturnType<typeof annotateBlocks> }) {
  const rows = () => {
    const gaps = gapsBeforeBlocks(props.annotated.map((item) => item.block));
    return props.annotated.map((item, index) => ({
      ...item,
      gapBefore: gaps[index] ?? false,
    }));
  };

  return (
    <For each={rows()}>
      {(item) => (
        <BlockRow
          block={item.block}
          gapBefore={item.gapBefore}
          showAssistantBullet={item.showAssistantBullet}
        />
      )}
    </For>
  );
}

function QueuedBlock(props: { line: ChatLine }) {
  return <BlockLine text={props.line.text} prefix="⏳ " />;
}

function BlankLine() {
  const theme = useTheme();
  return <text style={theme.theme().muted}>{blankLineContent()}</text>;
}

function SpinnerLine(props: { status: string; clock: () => number; startedAt: () => number | null }) {
  const theme = useTheme();
  const t = theme.theme;
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const frame = () => frames[Math.floor(props.clock() / 100) % frames.length];
  const label = () =>
    props.status === "connecting"
      ? "Connecting…"
      : props.status === "tool_running"
        ? "Working…"
        : props.status === "asking"
          ? "Waiting for your answer…"
          : props.status === "active"
            ? "Thinking…"
            : "Working…";
  const elapsed = () => (props.startedAt() ? formatMmss(props.clock() - props.startedAt()!) : "");

  return (
    <box height={1}>
      <text style={t().spinnerFrame}>{frame()}</text>
      <text style={t().spinnerLabel}> {label()} {elapsed()}</text>
    </box>
  );
}

function BlockRow(props: {
  block: CollapsedBlock;
  gapBefore: boolean;
  showAssistantBullet: boolean;
}) {
  const theme = useTheme();
  const t = theme.theme;

  if (props.block.kind === "text") {
    return (
      <PrefixedLines
        text={props.block.text}
        gapBefore={props.gapBefore}
        firstPrefix={props.showAssistantBullet ? ASSISTANT_BULLET : ASSISTANT_CONTINUATION}
        contPrefix={ASSISTANT_CONTINUATION}
        lineStyle={t().text}
        bulletStyle={props.showAssistantBullet ? t().assistantBullet : t().text}
        collapseHint={props.block.collapseHint}
      />
    );
  }

  if (props.block.kind === "thinking") {
    return (
      <PrefixedLines
        text={props.block.text}
        gapBefore={props.gapBefore}
        firstPrefix={THINKING_PREFIX}
        contPrefix={THINKING_PREFIX}
        lineStyle={t().thinking}
        bulletStyle={t().thinking}
        collapseHint={props.block.collapseHint}
      />
    );
  }

  let style = t().muted;
  let prefix = "";
  switch (props.block.kind) {
    case "tool":
      style = props.block.timing === undefined && !props.block.collapseHint ? t().toolRunning : t().toolCall;
      prefix = "▸ ";
      break;
    case "ask":
      style = t().ask;
      prefix = "? ";
      break;
    case "reply":
      style = t().ask;
      prefix = "▸ ";
      break;
    default:
      break;
  }

  const text =
    props.block.kind === "tool"
      ? `${prefix}${props.block.name}${props.block.timing ? " " + props.block.timing : ""}${props.block.collapseHint ? " ··· " + props.block.collapseHint : ""}`
      : `${prefix}${"text" in props.block ? props.block.text : ""}`;

  return (
    <box flexDirection="column">
      <Show when={props.gapBefore}>
        <BlankLine />
      </Show>
      <text style={style}>{text}</text>
    </box>
  );
}

function PrefixedLines(props: {
  text: string;
  gapBefore: boolean;
  firstPrefix: string;
  contPrefix: string;
  lineStyle: Style;
  bulletStyle: Style;
  collapseHint?: string;
}) {
  const lines = () => props.text.split("\n");
  return (
    <box flexDirection="column">
      <Show when={props.gapBefore}>
        <BlankLine />
      </Show>
      <For each={lines()}>
        {(line, index) => (
          <text style={index() === 0 ? props.bulletStyle : props.lineStyle}>
            {`${index() === 0 ? props.firstPrefix : props.contPrefix}${line}`}
            {index() === lines().length - 1 && props.collapseHint ? ` ··· ${props.collapseHint}` : ""}
          </text>
        )}
      </For>
    </box>
  );
}

function BlockLine(props: { text: string; prefix?: string; style?: Style }) {
  const lines = () => props.text.split("\n");
  return (
    <box flexDirection="column">
      <For each={lines()}>
        {(line, index) => (
          <text style={props.style}>
            {`${index() === 0 ? (props.prefix ?? "") : "  "}${line}`}
          </text>
        )}
      </For>
    </box>
  );
}
