import type { ReactNode } from "react";

export function IconButton({
  children,
  disabled = false,
  label,
  onClick,
  pressed = false
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onClick?: () => void;
  readonly pressed?: boolean;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
