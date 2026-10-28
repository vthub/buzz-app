// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { GitPullRequestIcon } from "../../shared/design-system/icons";
import { presentPull } from "./attention";

afterEach(cleanup);

const watch = (pr: unknown) => ({
  type: "source" as const,
  interest_id: "release",
  enabled: true,
  provider: "attention/github-pr",
  config: { pr },
});

it("names the pull request and opens whose feedback wakes agents", async () => {
  const open = vi.fn();
  const shown = presentPull({ open })(
    watch("https://github.com/block/buzz-app/pull/1578"),
    "buzz-app#1578 Release checks",
  );
  expect(shown).toMatchObject({
    type: "GitHub PR",
    icon: GitPullRequestIcon,
    target: "buzz-app#1578",
    subtitle: "Release checks",
    link: {
      href: "https://github.com/block/buzz-app/pull/1578",
      title: "Open on GitHub",
    },
  });
  const Details = shown.details as NonNullable<typeof shown.details>;
  render(<Details />);
  await userEvent.click(
    screen.getByRole("button", { name: "Choose who can wake agents" }),
  );
  expect(open).toHaveBeenCalledWith({
    version: 1,
    kind: "settings",
    section: "buzz.github/authors",
  });
});

it("leaves a watch without a pull request URL to its name", () => {
  expect(presentPull({ open: vi.fn() })(watch(42), "Release")).toEqual({
    type: "GitHub PR",
    icon: GitPullRequestIcon,
  });
});
