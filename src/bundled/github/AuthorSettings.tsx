import { useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Header } from "../../shared/design-system/ui/Header";
import { Textarea } from "../../shared/design-system/ui/Textarea";
import { loadPolicy, open, parse, savePolicy } from "./authors";

/** Whose pull request comments and reviews wake agents watching it. */
export function AuthorSettings({ active }: { active(): boolean }) {
  const [saved, setSaved] = useState(loadPolicy);
  const [draft, setDraft] = useState(saved.text);
  const [error, setError] = useState("");
  const parsed = parse(draft);
  const dirty = typeof parsed === "string" || parsed.text !== saved.text;
  return (
    <section aria-label="GitHub comment authors settings">
      <Header
        title="GitHub comment authors"
        subtitle="Agents watching a pull request are woken by CI, and by the comments and reviews these rules allow."
      />
      <form
        aria-label="GitHub comment author rules"
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!active() || !dirty) return;
          try {
            const policy = savePolicy(draft);
            setSaved(policy);
            setDraft(policy.text);
            setError("");
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        }}
      >
        {open(saved) && (
          <p role="status" className="m-0 text-body-sm text-subtle">
            A bare allow rule lets comments from anyone it reaches wake your
            agents. Replace it with allow org:name or allow author:login to
            limit them.
          </p>
        )}
        <Field
          label="Rules"
          description="One per line: allow or deny, then any of author:login, author:/pattern/, org:organization, body:/pattern/ and prefix:text, which runs to the end of the line. author:@me is your GitHub account, a bot's login ends in [bot], and logins match case aside. The first rule that matches decides; feedback no rule matches wakes nobody. Membership your GitHub account cannot see, or of a misspelled organization, counts as none."
        >
          <Textarea
            rows={6}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
          />
        </Field>
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
