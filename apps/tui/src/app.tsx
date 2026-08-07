import { useTerminalDimensions } from "@opentui/solid";
import { LocalProvider } from "./context/local.js";
import { ThemeProvider } from "./context/theme.js";
import { SyncProvider } from "./persistence.js";
import { SessionRoute } from "./routes/session.js";

export function App(props: { serverUrl: string; banner: string[]; onQuit: () => void }) {
  return (
    <LocalProvider onQuit={props.onQuit}>
      <ThemeProvider mode="dark">
        <SyncProvider url={props.serverUrl} banner={props.banner}>
          <Root />
        </SyncProvider>
      </ThemeProvider>
    </LocalProvider>
  );
}

function Root() {
  const dimensions = useTerminalDimensions();

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
    >
      <SessionRoute />
    </box>
  );
}
