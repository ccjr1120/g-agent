import { createRoot, createContext, useContext, type ParentProps } from "solid-js";
import { createThemeStore, type Theme } from "../theme/index.js";

export type ThemeMode = "dark" | "light";

type ThemeStore = {
  theme: () => Theme;
  setTheme: (t: Theme) => void;
};

const ThemeContext = createContext<ThemeStore>();

export function ThemeProvider(props: ParentProps<{ mode: ThemeMode }>) {
  const store = createRoot(() => createThemeStore(props.mode));
  return (
    <ThemeContext.Provider value={store}>
      {props.children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const store = useContext(ThemeContext);
  if (!store) throw new Error("useTheme must be used within a ThemeProvider");
  return store;
}