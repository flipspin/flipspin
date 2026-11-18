import { useId, type ReactNode } from "react";

// One on/off setting: label (and an optional line under it) on the left, the
// switch on the right, the whole row a `role="switch"` button. Saves on flip —
// the caller owns the value, the saving flag and any revert on failure.
interface SettingsSwitchRowProps {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}

export default function SettingsSwitchRow({ label, hint, checked, onChange, disabled }: SettingsSwitchRowProps) {
  const labelId = useId();
  const hintId = useId();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelId}
      aria-describedby={hint ? hintId : undefined}
      onClick={onChange}
      disabled={disabled}
      className="settings-switch-row"
    >
      <span className="settings-switch-row__text">
        <span id={labelId} className="settings-switch-row__label">{label}</span>
        {hint ? <span id={hintId} className="settings-switch-row__hint">{hint}</span> : null}
      </span>
      <span className="settings-switch" data-on={checked ? "true" : "false"} aria-hidden />
    </button>
  );
}
