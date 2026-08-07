#!/usr/bin/env bun
/**
 * Global CLI entry. Registers the SolidJS transform plugin before loading the
 * JSX entrypoint so `g-agent` works from any working directory (bunfig.toml
 * preload only applies when run from the package dir).
 */
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

ensureSolidTransformPlugin({ moduleName: "@opentui/solid" });

const root = dirname(dirname(fileURLToPath(import.meta.url)));
process.chdir(root);

const { main } = await import(join(root, "src", "index.tsx"));
main();
