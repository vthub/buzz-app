import { Button as BaseButton } from "@base-ui/react/button";
import type { ComponentProps, ReactNode } from "react";

/** One navigation surface for a primary row and independent sibling controls.
 * The primary NavigationItem still owns focus and aria-current. */
export function NavigationCard({
  className,
  children,
  footer,
  body,
  tone = "default",
  ...props
}: ComponentProps<"div"> & {
  footer?: ReactNode;
  body?: ReactNode;
  tone?: "default" | "tonal" | "inset";
}) {
  return (
    <div
      {...props}
      data-buzz-ui=""
      data-navigation-card=""
      data-tone={tone}
      className={`navigation-card ${className ?? ""}`}
    >
      <div className="navigation-card-row">{children}</div>
      {footer && <div className="navigation-card-footer">{footer}</div>}
      {body && <div className="navigation-card-body">{body}</div>}
    </div>
  );
}

export function NavigationItem({
  label,
  icon,
  trailing,
  selected = false,
  highlighted = false,
  inset = false,
  variant = "row",
  multiline = false,
  ...props
}: {
  label: ReactNode;
  icon?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  /** Transient picker focus; persistent navigation selection stays separate. */
  highlighted?: boolean;
  inset?: boolean;
  variant?: "row" | "pill" | "option" | "search" | "text";
  /** Stacked labels grow the row without clipping its primary target. */
  multiline?: boolean;
} & Omit<ComponentProps<typeof BaseButton>, "className" | "children">) {
  return (
    <BaseButton
      {...props}
      type={props.type ?? "button"}
      data-variant={variant}
      data-multiline={multiline || undefined}
      data-buzz-ui=""
      className="navigation-item"
      data-selected={selected || undefined}
      data-highlighted={highlighted || undefined}
      data-inset={inset || undefined}
      aria-current={props["aria-current"] ?? (selected ? "page" : undefined)}
    >
      {icon}
      <span className="navigation-item-label">{label}</span>
      {trailing ? (
        <span className="navigation-item-trailing">{trailing}</span>
      ) : null}
    </BaseButton>
  );
}
