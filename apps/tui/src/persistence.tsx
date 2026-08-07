import { createSimpleContext } from "./context/helper.js";
import { getSync } from "./context/sync.js";
import type { ParentProps } from "solid-js";

export const SyncContext = createSimpleContext<
  ReturnType<typeof getSync>,
  { url: string; banner: string[] }
>({
  name: "Sync",
  init({ url, banner }) {
    return getSync(url, banner);
  },
});

export function useSync() {
  return SyncContext.use();
}

export function SyncProvider(props: ParentProps<{ url: string; banner: string[] }>) {
  return (
    <SyncContext.provider url={props.url} banner={props.banner}>
      {props.children}
    </SyncContext.provider>
  );
}