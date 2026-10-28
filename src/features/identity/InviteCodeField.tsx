import { useId, useState } from "react";
import { Button } from "../../shared/design-system/ui/Button";
import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";

/**
 * The invite page's code field with its Join button. A refusal shows under
 * the field until the code is edited; the typed code is kept either way.
 */
export function InviteCodeField({
  error,
  busy,
  pending,
  onSubmit,
}: {
  /** Why the relay refused the last code. */
  error?: string | undefined;
  /** Something on the page is in flight: nothing can be submitted. */
  busy: boolean;
  /** This field's own claim is the one in flight. */
  pending: boolean;
  onSubmit: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  const [edited, setEdited] = useState(false);
  const errorId = useId();
  const shown = edited ? undefined : error;
  const value = code.trim();
  const submit = () => {
    if (!value || busy) return;
    setEdited(false);
    onSubmit(value);
  };
  // `CommunityUrlField`'s recipe: the error sits below the row, so Join stays
  // aligned with the input.
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <Field label="Invite code" invalid={!!shown} disabled={busy}>
            <Input
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={256}
              value={code}
              disabled={busy}
              aria-describedby={shown ? errorId : undefined}
              onChange={(event) => {
                setCode(event.target.value);
                setEdited(true);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing)
                  return;
                event.preventDefault();
                submit();
              }}
            />
          </Field>
        </div>
        <Button disabled={busy || !value} onClick={submit}>
          {pending ? "Joining…" : "Join"}
        </Button>
      </div>
      {shown && (
        <p id={errorId} role="alert" className="m-0 text-body-sm text-danger">
          {shown}
        </p>
      )}
    </div>
  );
}
