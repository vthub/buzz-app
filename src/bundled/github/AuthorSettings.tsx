import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Header } from "../../shared/design-system/ui/Header";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import {
  limited,
  loadPolicy,
  savePolicy,
  validate,
  type AuthorPolicy,
} from "./authors";

type Lists = Omit<AuthorPolicy, "version">;
const FIELDS: [keyof Lists, string, string][] = [
  [
    "trustedOrganizations",
    "Trusted organizations",
    "One GitHub organization login per line. Their members' comments wake your agents.",
  ],
  [
    "trustedAuthors",
    "Trusted commenters",
    "One exact GitHub login per line. A bot's ends in [bot].",
  ],
  [
    "ignoredAuthors",
    "Ignored commenters",
    "One exact GitHub login per line. These never wake agents, even in a trusted organization.",
  ],
];
const lines = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
const text = (policy: AuthorPolicy) =>
  Object.fromEntries(
    FIELDS.map(([key]) => [key, policy[key].join("\n")]),
  ) as Record<keyof Lists, string>;

/** Whose pull request comments and reviews wake agents watching it. */
export function AuthorSettings({ active }: { active(): boolean }) {
  const [saved, setSaved] = useState(loadPolicy);
  const [draft, setDraft] = useState(() => text(saved));
  const [error, setError] = useState("");
  const policy: AuthorPolicy = {
    version: 1,
    trustedOrganizations: lines(draft.trustedOrganizations),
    trustedAuthors: lines(draft.trustedAuthors),
    ignoredAuthors: lines(draft.ignoredAuthors),
  };
  const dirty = JSON.stringify(policy) !== JSON.stringify(saved);
  return (
    <section aria-label="GitHub comment authors settings">
      <Header
        title="GitHub comment authors"
        subtitle="Agents watching a pull request are woken by CI, and by comments and reviews from these authors. Your own GitHub account always counts."
      />
      <form
        aria-label="GitHub author allowlist"
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!active() || !dirty) return;
          const invalid = validate(policy);
          if (invalid) return setError(invalid);
          savePolicy(policy);
          setSaved(policy);
          setDraft(text(policy));
          setError("");
        }}
      >
        {!limited(saved) && (
          <p role="status" className="m-0 text-body-sm text-subtle">
            No allowlist is set, so comments from anyone wake your agents. Add a
            trusted organization or commenter to limit them.
          </p>
        )}
        {FIELDS.map(([key, label, description]) => (
          <Field key={key} label={label} description={description}>
            <Textarea
              rows={3}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              autoComplete="off"
              value={draft[key]}
              onChange={(event) => {
                setDraft({ ...draft, [key]: event.target.value });
              }}
            />
          </Field>
        ))}
        {error && (
          <p role="alert" className="m-0 text-body-sm text-danger">
            {error}
          </p>
        )}
        <div>
          <Button type="submit" variant="primary" disabled={!dirty}>
            Save
          </Button>
        </div>
      </form>
    </section>
  );
}
