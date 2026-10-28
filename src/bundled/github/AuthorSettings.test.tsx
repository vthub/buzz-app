// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { AuthorSettings } from "./AuthorSettings";
import { DEFAULT_RULES, loadPolicy } from "./authors";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("shows the default rules, and saves only rules that parse", async () => {
  const user = userEvent.setup();
  render(<AuthorSettings active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "A bare allow rule lets comments from anyone",
  );
  const rules = screen.getByRole("textbox", { name: /Rules/ });
  expect(rules).toHaveValue(DEFAULT_RULES);
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toBeDisabled();
  await user.clear(rules);
  await user.type(rules, "deny author:@me prefix:🤖{Enter}allow author:/(/");
  await user.click(save);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Line 2: Invalid regular expression",
  );
  expect(loadPolicy().text).toBe(DEFAULT_RULES);
  await user.clear(rules);
  await user.type(
    rules,
    "deny author:@me prefix:🤖{Enter}allow org:block{Enter}  allow author:/^copilot/  ",
  );
  await user.click(save);
  expect(loadPolicy().text).toBe(
    "deny author:@me prefix:🤖\nallow org:block\nallow author:/^copilot/",
  );
  expect(rules).toHaveValue(loadPolicy().text);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(save).toBeDisabled();
});
