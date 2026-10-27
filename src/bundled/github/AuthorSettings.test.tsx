// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { AuthorSettings } from "./AuthorSettings";
import { loadPolicy } from "./authors";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("warns until an allowlist is saved, and saves only valid logins", async () => {
  const user = userEvent.setup();
  render(<AuthorSettings active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "comments from anyone wake your agents",
  );
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toBeDisabled();
  await user.type(
    screen.getByRole("textbox", { name: /Trusted commenters/ }),
    "two words",
  );
  await user.click(save);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "two words is not a GitHub login",
  );
  expect(loadPolicy().trustedAuthors).toEqual([]);
  const commenters = screen.getByRole("textbox", {
    name: /Trusted commenters/,
  });
  await user.clear(commenters);
  await user.type(commenters, "wes{Enter}copilot[[bot]");
  await user.type(
    screen.getByRole("textbox", { name: /Trusted organizations/ }),
    "block",
  );
  await user.click(save);
  expect(loadPolicy()).toEqual({
    version: 1,
    trustedOrganizations: ["block"],
    trustedAuthors: ["wes", "copilot[bot]"],
    ignoredAuthors: [],
  });
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(save).toBeDisabled();
});
