import { expect, it } from "vitest";
import { reviewAssessment, reviewPrompt } from "./models";

it("asks the configured model to assess exact arguments together with preceding authorization", () => {
  const action = {
    kind: "tool" as const,
    session: "one",
    content: {
      arguments: { command: "write" },
      conversation: [{ role: "user", content: "only read" }],
    },
  };
  const prompt = reviewPrompt(action);
  expect(prompt).toContain("preceding conversation together");
  expect(prompt).toContain(JSON.stringify(action));
  expect(reviewPrompt({ ...action, kind: "context" })).toContain(
    "prompt injection",
  );
});

it("accepts only an explicit, exact structured decision and records the actual model", () => {
  const model = {
    runtime: "buzz.pi",
    provider: "configured",
    id: "custom-model",
  };
  expect(
    reviewAssessment('{"blocked":false,"reason":"Authorized read"}', model),
  ).toEqual({
    blocked: false,
    reason: "Authorized read",
    model: "buzz.pi/configured/custom-model",
  });
  for (const text of [
    "{}",
    '{"blocked":"false","reason":"safe"}',
    '{"blocked":false,"reason":""}',
    '{"blocked":false,"reason":"safe","approved":true}',
    '```json\n{"blocked":false,"reason":"safe"}\n```',
  ])
    expect(() => reviewAssessment(text, model)).toThrow();
});
