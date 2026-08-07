import { createContext, Show, useContext, type ParentProps, type JSX } from "solid-js";

export function createSimpleContext<T, Props extends Record<string, unknown>>(input: {
  name: string;
  init: ((input: Props) => T) | (() => T);
  render?: (value: T) => JSX.Element;
}) {
  const ctx = createContext<T>();

  const Provider = (props: ParentProps<Props>) => {
    const value = (input.init as (input: Props) => T)(props);
    const ready = (value as { ready?: boolean }).ready;
    return (
      <Show when={ready === undefined || ready === true}>
        <ctx.Provider value={value}>{props.children}</ctx.Provider>
      </Show>
    );
  };

  function use(): T {
    const value = useContext(ctx);
    if (value === undefined) {
      throw new Error(`${input.name} context must be used within a context provider`);
    }
    return value;
  }

  return {
    context: ctx,
    provider: Provider,
    use,
  };
}