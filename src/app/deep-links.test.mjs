import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { isBuzzLink } from "../features/navigation/buzz-links";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

it("declares exactly the in-app link scheme so packages can claim it", () => {
  // Bundled and released apps use the scheme in-app links produce.
  const config = JSON.parse(read("../../src-tauri/tauri.conf.json"));
  const schemes = config.plugins["deep-link"].desktop.schemes;
  expect(config.plugins["deep-link"]).toEqual({ desktop: { schemes } });
  expect(schemes).toEqual(["buzz"]);
  expect(isBuzzLink(`${schemes[0]}://channel/general`)).toBe(true);
  expect(config.bundle.active).toBe(true);
});

it("keeps the webview off the plugin's own commands; the shell owns the OS scheme", () => {
  // Rust drains OS URLs into the webview as raw strings through two main-window
  // app commands. The webview can subscribe to native session events but cannot
  // register schemes or emit arbitrary Tauri events.
  const capability = JSON.parse(
    read("../../src-tauri/capabilities/default.json"),
  );
  const identifiers = capability.permissions.map((permission) =>
    typeof permission === "string" ? permission : permission.identifier,
  );
  expect(identifiers.filter((id) => id.startsWith("deep-link:"))).toEqual([]);
  expect(identifiers.filter((id) => id.startsWith("core:event:"))).toEqual([
    "core:event:allow-listen",
    "core:event:allow-unlisten",
  ]);
});
