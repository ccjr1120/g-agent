import { createEffect, createSignal, For, Show } from "solid-js";
import { useKeyboard } from "@opentui/solid";
import { useTheme } from "../context/theme.js";
import { useSync } from "../persistence.js";
import { useLocal } from "../context/local.js";
import { buildMenuItems, type SlashCommand } from "../commands/menu.js";
import { dispatchActions } from "../commands/dispatch.js";
import { listSessions } from "../sessions.js";

const MENU_VISIBLE_ROWS = 6;

type AskRow = { kind: "option"; text: string } | { kind: "chat-other" };

export function Composer() {
  const sync = useSync();
  const theme = useTheme();
  const local = useLocal();
  const t = theme.theme;

  const [text, setText] = createSignal("");
  const [menuIndex, setMenuIndex] = createSignal(0);
  const [askCustom, setAskCustom] = createSignal(false);

  createEffect(() => {
    const restore = local.restoreText();
    if (restore !== undefined) {
      setText(restore);
      local.setRestoreText(undefined);
    }
  });

  createEffect(() => {
    const complete = sync.pendingComplete();
    if (complete !== undefined) {
      setText(complete);
      sync.setPendingComplete(undefined);
    }
  });

  createEffect(() => {
    sync.asks();
    sync.activeAsk();
    setAskCustom(false);
  });

  const menuItems = (): SlashCommand[] => {
    const raw = text().trim();
    if (!raw.startsWith("/")) return [];
    return buildMenuItems(raw, {
      agents: sync.catalog.agents,
      skills: sync.catalog.skills,
      mcp: sync.catalog.mcp,
      agentTasks: sync.agentTasks(),
      savedSessions: listSessions(),
      activeAgent: sync.activeAgent(),
    });
  };

  const menuOpen = () => local.panelFocus() === "input" && text().trim().startsWith("/") && menuItems().length > 0;
  const isAskMode = () => sync.asks().length > 0 && local.panelFocus() === "input";
  const currentAsk = () => sync.asks()[sync.activeAsk()];

  const askOptions = () => currentAsk()?.options ?? [];
  const askRows = (): AskRow[] => [
    ...askOptions().map((option) => ({ kind: "option" as const, text: option })),
    { kind: "chat-other" as const },
  ];
  const askInOptions = () => isAskMode() && askOptions().length > 0 && !askCustom();

  function isEnter(name: string): boolean {
    return name === "return" || name === "linefeed" || name === "enter";
  }

  function stopEvent(event: { stopPropagation?: () => void; preventDefault?: () => void }) {
    event.stopPropagation?.();
    event.preventDefault?.();
  }

  function runInput(content: string) {
    const trimmed = content.trim();
    if (!trimmed) return;

    if (isAskMode()) {
      sync.submitAskReply(trimmed);
      setText("");
      setAskCustom(false);
      local.setAskOptionIndex(0);
      return;
    }

    if (trimmed.startsWith("/") || trimmed === "exit") {
      const actions = dispatchActions({
        text: trimmed,
        activeSlot: sync.activeSlot(),
        turnBusy: sync.isTurnBusy(),
        activeAgent: sync.activeAgent(),
        agents: sync.catalog.agents,
        skills: sync.catalog.skills,
        mcp: sync.catalog.mcp,
        scheduledTasks: sync.scheduledTasks(),
        transcriptLines: sync.transcriptForExport(),
      });
      const quit = sync.runActions(actions);
      if (quit) local.onQuit();
      if (!actions.some((a) => a.type === "complete")) setText("");
      setMenuIndex(0);
      return;
    }

    local.inputHistory.push(trimmed);
    sync.submit(trimmed);
    setText("");
    setMenuIndex(0);
    local.setHistoryScroll(0);
  }

  function submit() {
    runInput(text());
  }

  function submitItem(item: SlashCommand) {
    if (item.chatOther) {
      setText("");
      setMenuIndex(0);
      return;
    }
    if (item.value.endsWith(" ")) {
      setText(item.value);
      return;
    }
    runInput(item.value);
  }

  function confirmAskOption() {
    const ask = currentAsk();
    if (!ask) return;
    const picked = askRows()[local.askOptionIndex()];
    if (!picked) return;
    if (picked.kind === "chat-other") {
      setText("");
      setAskCustom(true);
      return;
    }
    sync.submitAskReply(picked.text);
    setAskCustom(false);
    setText("");
    local.setAskOptionIndex(0);
  }

  function handleEscape() {
    if (isAskMode()) {
      if (askCustom()) {
        setAskCustom(false);
        return;
      }
      setText("");
      sync.skipAsk();
      local.setAskOptionIndex(0);
      return;
    }
    if (menuOpen()) {
      setText("");
      setMenuIndex(0);
      return;
    }
    if (local.panelFocus() !== "input") {
      local.resetPanelFocus();
      return;
    }
    const restored = sync.cancelTurn();
    if (restored !== null) {
      setText(restored);
      return;
    }
  }

  useKeyboard((event) => {
    if (!local.composerEnabled() && local.panelFocus() === "input") return;

    const name = event.name;
    const ctrl = "ctrl" in event && Boolean((event as { ctrl?: boolean }).ctrl);
    const meta = "meta" in event && Boolean((event as { meta?: boolean }).meta);
    const alt = "alt" in event && Boolean((event as { alt?: boolean }).alt);

    if (name === "c" && ctrl) {
      if (isAskMode()) {
        handleEscape();
        return;
      }
      if (menuOpen()) {
        setText("");
        setMenuIndex(0);
        return;
      }
      if (local.panelFocus() !== "input") {
        local.resetPanelFocus();
        return;
      }
      const restored = sync.cancelTurn();
      if (restored !== null) setText(restored);
      return;
    }

    if (name === "t" && ctrl) {
      local.toggleExpandThinking();
      return;
    }

    if (name === "tab" && !("shift" in event && (event as { shift?: boolean }).shift) && local.panelFocus() === "input" && !menuOpen()) {
      if (isAskMode() && sync.asks().length > 1) {
        const next = (sync.activeAsk() + 1) % sync.asks().length;
        sync.setActiveAsk(next);
        local.setAskOptionIndex(0);
        setAskCustom(false);
        setText("");
        return;
      }
      local.cyclePanelFocus(visiblePanels());
      local.setComposerEnabled(local.panelFocus() === "input");
      return;
    }

    if ((name === "left" || name === "right") && isAskMode() && sync.asks().length > 1) {
      const delta = name === "left" ? -1 : 1;
      const count = sync.asks().length;
      sync.setActiveAsk((sync.activeAsk() + delta + count) % count);
      local.setAskOptionIndex(0);
      setAskCustom(false);
      setText("");
      return;
    }

    if (local.panelFocus() !== "input") {
      handlePanelKeys(name);
      return;
    }

    if (name === "esc" || name === "escape") {
      handleEscape();
      return;
    }

    if (name === "0" && (meta || alt)) {
      sync.send({ type: "agent_back" });
      return;
    }

    if (isAskMode()) {
      if (askInOptions()) {
        if (name === "up" || name === "down") {
          local.moveAskOption(name === "up" ? -1 : 1, askRows().length);
          stopEvent(event);
          return;
        }
        if (isEnter(name)) {
          confirmAskOption();
          stopEvent(event);
          return;
        }
        return;
      }
      if (name === "up" || name === "down" || isEnter(name)) {
        return;
      }
      return;
    }

    if (menuOpen()) {
      if (name === "down") {
        setMenuIndex((i) => (i + 1) % menuItems().length);
        stopEvent(event);
        return;
      }
      if (name === "up") {
        setMenuIndex((i) => (i - 1 + menuItems().length) % menuItems().length);
        stopEvent(event);
        return;
      }
      if (isEnter(name)) {
        const item = menuItems()[menuIndex()];
        if (item) submitItem(item);
        stopEvent(event);
        return;
      }
      if (name === "tab") {
        const item = menuItems()[menuIndex()];
        if (item) submitItem(item);
        stopEvent(event);
        return;
      }
      return;
    }

    if (name === "up" || name === "down") {
      const delta = name === "up" ? -1 : 1;
      const next = local.inputHistory.move(delta);
      if (next !== null) setText(next);
    }
  });

  function visiblePanels(): import("../context/local.js").PanelFocus[] {
    const out: import("../context/local.js").PanelFocus[] = [];
    const plan = sync.plans[sync.sessionKey()];
    if (plan && plan.steps.length > 0 && !plan.steps.every((s) => s.state === "done")) out.push("plan");
    if (sync.scheduledTasks().length > 0) out.push("scheduled");
    if (sync.agentTasks().length > 0) out.push("subagents");
    return out;
  }

  function handlePanelKeys(name: string) {
    const focus = local.panelFocus();
    if (name === "esc" || name === "escape") {
      local.resetPanelFocus();
      return;
    }
    if (name === "pageup") {
      if (focus === "scheduled") local.setScheduledScroll((v) => Math.max(0, v - 3));
      if (focus === "subagents") local.setTaskScroll((v) => Math.max(0, v - 3));
      return;
    }
    if (name === "pagedown") {
      if (focus === "scheduled") local.setScheduledScroll((v) => v + 3);
      if (focus === "subagents") local.setTaskScroll((v) => v + 3);
      return;
    }
    if (name === "up") {
      if (focus === "scheduled") local.setScheduledScroll((v) => Math.max(0, v - 1));
      if (focus === "subagents") local.setTaskScroll((v) => Math.max(0, v - 1));
      return;
    }
    if (name === "down") {
      if (focus === "scheduled") local.setScheduledScroll((v) => v + 1);
      if (focus === "subagents") local.setTaskScroll((v) => v + 1);
    }
  }

  const placeholder = () => "Type a message… (/ for commands · exit to quit)";

  const askInputPlaceholder = () => {
    if (askCustom()) return "Type your own answer… · Enter send · Esc back";
    const total = sync.asks().length;
    return total > 1
      ? "Answer the question · Enter send · Esc skip · Tab switch"
      : "Answer the question · Enter send · Esc skip";
  };

  const askHint = () => {
    const total = sync.asks().length;
    const switchQuestion = total > 1 ? " · Tab switch" : "";
    return `↑/↓ select · Enter pick · Chat other… custom reply${switchQuestion} · Esc skip`;
  };

  const visibleMenuItems = () => {
    const items = menuItems();
    const selected = Math.min(menuIndex(), Math.max(0, items.length - 1));
    const start = Math.max(0, selected - (MENU_VISIBLE_ROWS - 1));
    return items.slice(start, start + MENU_VISIBLE_ROWS);
  };

  return (
    <box flexDirection="column">
      <Show when={isAskMode()}>
        <AskSelector
          ask={currentAsk}
          rows={askRows}
          optionIndex={local.askOptionIndex}
          custom={askCustom}
          total={sync.asks().length}
          activeAsk={sync.activeAsk()}
          inputValue={text}
          onInput={(value) => setText(value)}
          onSubmit={() => submit()}
          askInputPlaceholder={askInputPlaceholder}
          askHint={askHint}
        />
      </Show>
      <Show when={!isAskMode()}>
        <Show when={menuOpen()}>
          <box flexDirection="column">
            <text style={t().muted}>Commands · ↑↓ select · Enter run · Tab complete · Esc close</text>
            <For each={visibleMenuItems()}>
              {(item) => {
                const selected = () => menuItems().indexOf(item) === menuIndex();
                return (
                  <box flexDirection="row" height={1}>
                    <text style={selected() ? t().menuSelected : t().text}>
                      {`${selected() ? "❯ " : "  "}${item.label}  `}
                    </text>
                    <text style={t().menuDescription}>{item.description}</text>
                  </box>
                );
              }}
            </For>
          </box>
        </Show>
        <box
          border={["top", "bottom"]}
          borderColor={t().border.fg}
          flexDirection="row"
          minHeight={1}
          paddingLeft={1}
          paddingRight={1}
        >
          <text style={t().composerActive}>{"> "}</text>
          <input
            flexGrow={1}
            value={text()}
            placeholder={placeholder()}
            style={t().composerActive}
            placeholderColor={t().muted.fg}
            focused={local.panelFocus() === "input"}
            onInput={(v) => {
              setText(v);
              local.inputHistory.setDraft(v);
            }}
            onSubmit={() => submit()}
          />
        </box>
      </Show>
    </box>
  );
}

function AskSelector(props: {
  ask: () => { id: string; question: string; options?: string[] } | undefined;
  rows: () => AskRow[];
  optionIndex: () => number;
  custom: () => boolean;
  total: number;
  activeAsk: number;
  inputValue: () => string;
  onInput: (value: string) => void;
  onSubmit: () => void;
  askInputPlaceholder: () => string;
  askHint: () => string;
}) {
  const theme = useTheme();
  const t = theme.theme;

  return (
    <box border={["top", "bottom"]} borderColor={t().ask.fg} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Show when={props.ask()}>
        {(current) => (
          <>
            <text style={t().question}>
              {`${props.total > 1 ? `(${props.activeAsk + 1}/${props.total}) ` : ""}? ${current().question}`}
            </text>
            <Show
              when={(current().options?.length ?? 0) > 0}
              fallback={
                <AskInput
                  value={props.inputValue()}
                  placeholder={props.askInputPlaceholder()}
                  onInput={props.onInput}
                  onSubmit={props.onSubmit}
                />
              }
            >
              <For each={props.rows()}>
                {(row, index) => (
                  <box flexDirection="row" height={1}>
                    <text
                      style={
                        index() === props.optionIndex()
                          ? t().menuSelected
                          : row.kind === "chat-other"
                            ? t().askHint
                            : t().options
                      }
                    >
                      {`${index() === props.optionIndex() ? "❯ " : "  "}${
                        row.kind === "chat-other" ? "Chat other…" : row.text
                      }`}
                    </text>
                  </box>
                )}
              </For>
              <Show when={props.custom()}>
                <AskInput
                  value={props.inputValue()}
                  placeholder={props.askInputPlaceholder()}
                  onInput={props.onInput}
                  onSubmit={props.onSubmit}
                />
              </Show>
              <text style={t().askHint}>{props.askHint()}</text>
            </Show>
          </>
        )}
      </Show>
    </box>
  );
}

function AskInput(props: {
  value: string;
  placeholder: string;
  onInput: (value: string) => void;
  onSubmit: () => void;
}) {
  const theme = useTheme();
  const t = theme.theme;

  return (
    <box flexDirection="row" minHeight={1}>
      <text style={t().composerActive}>{"> "}</text>
      <input
        flexGrow={1}
        value={props.value}
        placeholder={props.placeholder}
        style={t().composerActive}
        placeholderColor={t().muted.fg}
        focused={true}
        onInput={props.onInput}
        onSubmit={props.onSubmit}
      />
    </box>
  );
}
