import { CircleNotchIcon } from "../../shared/design-system/icons/index";

/** The "Setting up Buzz" page: the current step's label beside a spinner. */
export function SetupProgress({ label }: { label: string }) {
  return (
    <>
      <h1
        id="welcome-title"
        tabIndex={-1}
        className="text-heading text-standard"
      >
        Setting up Buzz
      </h1>
      <p
        role="status"
        className="flex items-center gap-2 text-body text-subtle"
      >
        <CircleNotchIcon
          size={18}
          aria-hidden="true"
          className="motion-safe:animate-spin"
        />
        {label}
      </p>
    </>
  );
}
