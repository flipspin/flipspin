import { useId, type ComponentType, type CSSProperties, type ReactNode } from "react";

// One settings group inside the modal pane: white card, colored icon chip and
// title, then arbitrary body. The card is drawn to match the account panes'
// `.mk-card`; `color` paints both the chip and the accent strip on top.
// `trailing` is a control that sits at the right end of the title row; for a
// setting that is one choice (a language) and needs no body under it.
interface SettingsSectionProps {
  id?: string;
  icon?: ComponentType<{ size?: number }>;
  color?: string;
  title: ReactNode;
  description?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}

export default function SettingsSection({ id, icon: Icon, color, title, description, trailing, children }: SettingsSectionProps) {
  const titleId = useId();
  return (
    <section id={id} aria-labelledby={titleId} className="settings-panel-neu-divider" style={{ "--chip": color } as CSSProperties}>
      <div className="settings-panel-neu-section-head">
        <span className="settings-panel-neu-chip" aria-hidden>
          {Icon ? <Icon size={13} /> : null}
        </span>
        <h3 id={titleId} className="settings-panel-neu-section-title">{title}</h3>
        {trailing ? <div className="settings-section-trailing">{trailing}</div> : null}
      </div>
      {description ? <p className="settings-modal-hint">{description}</p> : null}
      {children}
    </section>
  );
}
