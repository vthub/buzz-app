import { Button } from "../../shared/design-system/ui/Button";
import { CaretDownIcon } from "../../shared/design-system/icons";
import type { SoloDisclosureProps } from "./solo-navigation-contract";
import styles from "./SoloDestination.module.css";

/** The host owns the disclosure icon, button states and disappearing-content focus. */
export function SoloDisclosure(props: SoloDisclosureProps) {
  return (
    <Button
      variant="plain"
      size="inline"
      data-solo-disclosure=""
      aria-label={props.label}
      title={props.label}
      aria-expanded={props.expanded}
      aria-controls={props.controls}
      onClick={(event) => {
        if (
          props.expanded &&
          document
            .getElementById(props.controls)
            ?.contains(document.activeElement)
        )
          event.currentTarget.focus({ preventScroll: true });
        props.onToggle();
      }}
    >
      <CaretDownIcon size={14} aria-hidden="true" />
      {props.summary && (
        <span className={styles.workerSummary}>{props.summary}</span>
      )}
    </Button>
  );
}
