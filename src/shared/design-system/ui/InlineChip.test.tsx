// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { chipFaces, resetChipFaces } from "../chips/faceResolver";
import { InlineChip } from "./InlineChip";

const address = { kind: "person" as const, id: "a".repeat(64) };
afterEach(() => {
  cleanup();
  resetChipFaces();
  vi.restoreAllMocks();
});

it("uses scoped faces without consulting or subscribing to the global registry", () => {
  const get = vi.spyOn(chipFaces, "get");
  const subscribe = vi.spyOn(chipFaces, "subscribe");
  const { rerender, container } = render(
    <InlineChip
      address={address}
      interactive={false}
      face={{ label: "Alice", loading: false, resolved: true }}
    />,
  );
  expect(screen.getByRole("img", { name: "Person Alice" })).toHaveTextContent(
    "@Alice",
  );
  rerender(
    <InlineChip
      address={address}
      interactive={false}
      face={{ label: "Other community", loading: false, resolved: true }}
    />,
  );
  expect(screen.queryByText("@Alice")).not.toBeInTheDocument();
  expect(
    screen.getByRole("img", { name: "Person Other community" }),
  ).toBeVisible();
  expect(get).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
  expect(container.querySelector("button, a, [tabindex], [title]")).toBeNull();
});

it("retains registry-backed rendering for existing consumers", () => {
  chipFaces.put(address, { label: "Alice", loading: false, resolved: true });
  render(<InlineChip address={address} interactive={false} />);
  expect(screen.getByRole("img", { name: "Person Alice" })).toBeVisible();
  act(() => {
    chipFaces.put(address, {
      label: "Renamed",
      loading: false,
      resolved: true,
    });
  });
  expect(screen.getByRole("img", { name: "Person Renamed" })).toBeVisible();
});

it("announces unresolved identities without pretending the fallback is a name", () => {
  render(
    <InlineChip
      address={{ ...address, kind: "agent" }}
      interactive={false}
      face={{ label: "aaaaaaaa…aaaa", loading: false, resolved: false }}
    />,
  );
  expect(screen.getByRole("img", { name: "Unresolved agent" })).toHaveAttribute(
    "data-state",
    "unresolved",
  );
});

it("shows a resolving mention as a busy chip whose spinner borrows the sigil's box", () => {
  const { container } = render(
    <InlineChip
      address={{ kind: "agent", id: "pending-1" }}
      face={{ label: "Example", loading: true, resolved: false }}
    />,
  );
  const chip = screen.getByRole("img", { name: "Resolving mention Example" });
  expect(chip).toHaveAttribute("aria-busy", "true");
  expect(chip).toHaveAttribute("data-state", "loading");
  // The glyph stays in the flow so the chip keeps its width when it returns.
  expect(chip).toHaveTextContent("@Example");
  const trigger = chip.querySelector(".inline-chip-trigger");
  expect(trigger).toHaveAttribute("data-loading");
  expect(trigger?.querySelector(".inline-chip-spinner")).toHaveAttribute(
    "aria-hidden",
    "true",
  );
  // Nothing truthful to preview or open yet, even for an interactive consumer.
  expect(container.querySelector("button")).toBeNull();
});

it("settling drops the spinner and the busy state without changing the glyph", () => {
  const { rerender } = render(
    <InlineChip
      address={address}
      interactive={false}
      face={{ label: "Example", loading: true, resolved: false }}
    />,
  );
  rerender(
    <InlineChip
      address={address}
      interactive={false}
      face={{ label: "Example", loading: false, resolved: true }}
    />,
  );
  const chip = screen.getByRole("img", { name: "Person Example" });
  expect(chip).not.toHaveAttribute("aria-busy");
  expect(chip.querySelector(".inline-chip-spinner")).toBeNull();
  expect(chip.querySelector(".inline-chip-trigger")).not.toHaveAttribute(
    "data-loading",
  );
  expect(chip).toHaveTextContent("@Example");
});

// jsdom does not load chips.css, so the stylesheet's side of the contract is
// checked as text: the hidden glyph keeps its box, and reduced motion stills
// the spinner.
it("styles the resolving sigil transparent and stills the spinner under reduced motion", () => {
  const css = readFileSync(
    "src/shared/design-system/styles/chips.css",
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  expect(css).toMatch(
    /\.inline-chip-trigger\[data-loading\]\s*\{[^}]*color:\s*transparent;/,
  );
  const reduced = css.match(
    /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n {2}\}/,
  );
  expect(reduced?.[1]).toMatch(
    /\.inline-chip-spinner\s*\{[^}]*animation:\s*none;/,
  );
});

it("keeps an accessible qualifier separate from the authored name and stays inert", () => {
  const { container } = render(
    <InlineChip
      address={address}
      interactive={false}
      face={{ label: "Honey", resolved: true, loading: false }}
      qualifier={{
        text: "npub…caj",
        accessibleLabel: "public key ending c a j",
        reveal: true,
      }}
    />,
  );
  expect(
    screen.getByRole("img", { name: "Person Honey, public key ending c a j" }),
  ).toHaveTextContent("@Honey npub…caj");
  expect(container.querySelector(".inline-chip-label")).toHaveTextContent(
    "@Honey",
  );
  expect(container.querySelector(".inline-chip-qualifier")).toHaveAttribute(
    "data-reveal",
  );
  expect(container.querySelector("button, a, [tabindex], [title]")).toBeNull();
});
