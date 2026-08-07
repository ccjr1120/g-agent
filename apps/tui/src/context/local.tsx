import { createContext, createSignal, useContext, type ParentProps } from "solid-js";
import { InputHistory } from "../input-history.js";

export type Route = { type: "session" } | { type: "home" };

export type PanelFocus = "input" | "ask" | "plan" | "scheduled" | "subagents";

type LocalContextValue = {
  route: () => Route;
  navigate: (route: Route) => void;
  panelFocus: () => PanelFocus;
  setPanelFocus: (f: PanelFocus) => void;
  cyclePanelFocus: (visible: PanelFocus[]) => void;
  resetPanelFocus: () => void;
  scheduledScroll: () => number;
  setScheduledScroll: (n: number | ((prev: number) => number)) => void;
  taskScroll: () => number;
  setTaskScroll: (n: number | ((prev: number) => number)) => void;
  expandThinking: () => boolean;
  toggleExpandThinking: () => void;
  historyScroll: () => number;
  setHistoryScroll: (n: number) => void;
  scrollHistory: (delta: number, max: number) => void;
  restoreText: () => string | undefined;
  setRestoreText: (text: string | undefined) => void;
  askOptionIndex: () => number;
  setAskOptionIndex: (n: number) => void;
  moveAskOption: (delta: -1 | 1, max: number) => void;
  inputHistory: InputHistory;
  onQuit: () => void;
  composerEnabled: () => boolean;
  setComposerEnabled: (enabled: boolean) => void;
};

const LocalContext = createContext<LocalContextValue>();

export function LocalProvider(props: ParentProps<{ onQuit: () => void }>) {
  const [route, setRoute] = createSignal<Route>({ type: "session" });
  const [panelFocus, setPanelFocus] = createSignal<PanelFocus>("input");
  const [scheduledScroll, setScheduledScroll] = createSignal(0);
  const [taskScroll, setTaskScroll] = createSignal(0);
  const [expandThinking, setExpandThinking] = createSignal(false);
  const [historyScroll, setHistoryScroll] = createSignal(0);
  const [restoreText, setRestoreText] = createSignal<string | undefined>(undefined);
  const [askOptionIndex, setAskOptionIndex] = createSignal(0);
  const [composerEnabled, setComposerEnabled] = createSignal(true);
  const inputHistory = new InputHistory();

  function cyclePanelFocus(visible: PanelFocus[]) {
    if (visible.length === 0) {
      resetPanelFocus();
      return;
    }
    const current = panelFocus();
    if (current === "input") {
      setPanelFocus(visible[0]);
      return;
    }
    const idx = visible.indexOf(current);
    if (idx === -1 || idx === visible.length - 1) {
      resetPanelFocus();
      return;
    }
    setPanelFocus(visible[idx + 1]);
  }

  function resetPanelFocus() {
    setPanelFocus("input");
    setScheduledScroll(0);
    setTaskScroll(0);
    setComposerEnabled(true);
  }

  function setScheduledScrollValue(n: number | ((prev: number) => number)) {
    setScheduledScroll(typeof n === "function" ? n(scheduledScroll()) : n);
  }

  function setTaskScrollValue(n: number | ((prev: number) => number)) {
    setTaskScroll(typeof n === "function" ? n(taskScroll()) : n);
  }

  function moveAskOption(delta: -1 | 1, max: number) {
    if (max <= 0) return;
    setAskOptionIndex((prev) => (prev + delta + max) % max);
  }

  return (
    <LocalContext.Provider
      value={{
        route,
        navigate: setRoute,
        panelFocus,
        setPanelFocus,
        cyclePanelFocus,
        resetPanelFocus,
        scheduledScroll,
        setScheduledScroll: setScheduledScrollValue,
        taskScroll,
        setTaskScroll: setTaskScrollValue,
        expandThinking,
        toggleExpandThinking: () => setExpandThinking((v) => !v),
        historyScroll,
        setHistoryScroll,
        scrollHistory(delta: number, max: number) {
          setHistoryScroll((prev) => Math.max(0, Math.min(max, prev + delta)));
        },
        restoreText,
        setRestoreText,
        askOptionIndex,
        setAskOptionIndex,
        moveAskOption,
        inputHistory,
        onQuit: props.onQuit,
        composerEnabled,
        setComposerEnabled,
      }}
    >
      {props.children}
    </LocalContext.Provider>
  );
}

export function useLocal() {
  const ctx = useContext(LocalContext);
  if (!ctx) throw new Error("useLocal must be used within a LocalProvider");
  return ctx;
}
