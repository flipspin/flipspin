/* krobi-ui; AGPL-3.0; see LICENSE. */
import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { mergeAriaIds, useFieldContext } from "./FieldContext";
import { Icon } from "./icons";
import { formatFileSize } from "./intl";
import { useKrobiUiLocale, useKrobiUiStrings } from "./strings";

export type FileRejectReason = "type" | "size";

export interface FileInputProps {
  value?: File[];
  onChange: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  /** bytes; larger files are rejected and reported. */
  maxSize?: number;
  name?: string;
  required?: boolean;
  invalid?: boolean;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  onReject?: (files: File[], reason: FileRejectReason) => void;
  disabled?: boolean;
  helper?: ReactNode;
  hint?: ReactNode;
  className?: string;
}

function accepts(file: File, accept?: string) {
  if (!accept) return true;
  return accept.split(",").some((raw) => {
    const rule = raw.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith(".")) return file.name.toLowerCase().endsWith(rule);
    if (rule.endsWith("/*")) return file.type.toLowerCase().startsWith(rule.slice(0, -1));
    return file.type.toLowerCase() === rule;
  });
}

/** a drop zone + file list. wears `.zr-file`; no primitive exists for it. */
export function FileInput({
  value,
  onChange,
  accept,
  multiple,
  maxSize,
  name,
  required,
  invalid,
  ariaLabel,
  ariaDescribedBy,
  onReject,
  disabled,
  helper,
  hint,
  className,
}: FileInputProps) {
  const locale = useKrobiUiLocale();
  const strings = useKrobiUiStrings();
  const field = useFieldContext();
  const generatedId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [internal, setInternal] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [rejection, setRejection] = useState<string | null>(null);
  const files = value ?? internal;
  const isRequired = required ?? field?.required;
  const isInvalid = invalid ?? field?.invalid ?? !!rejection;
  const helperId = helper != null ? `${generatedId}-helper` : undefined;
  const rejectionId = rejection ? `${generatedId}-rejection` : undefined;
  const describedBy = mergeAriaIds(ariaDescribedBy, field?.describedBy, helperId, rejectionId);

  const syncNativeFiles = (next: File[]) => {
    const input = inputRef.current;
    if (!input || typeof DataTransfer === "undefined") return;
    const transfer = new DataTransfer();
    next.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
  };

  useEffect(() => {
    syncNativeFiles(files);
    // File identity is the meaningful value; callers should memoize a controlled array.
  }, [files]);

  const setFiles = (next: File[]) => {
    if (value == null) setInternal(next);
    syncNativeFiles(next);
    onChange(next);
  };
  const addFiles = (incoming: FileList | File[]) => {
    if (disabled) return;
    const incomingFiles = Array.from(incoming);
    const badType = incomingFiles.filter((file) => !accepts(file, accept));
    const badSize = incomingFiles.filter((file) => maxSize != null && file.size > maxSize);
    badType.length && onReject?.(badType, "type");
    badSize.length && onReject?.(badSize, "size");
    const messages = [
      badType.length ? strings.fileTypeRejected(badType.length) : null,
      badSize.length ? strings.fileSizeRejected(badSize.length, formatFileSize(maxSize!, locale)) : null,
    ].filter(Boolean);
    setRejection(messages.length ? messages.join("; ") : null);
    let arr = incomingFiles.filter((file) => accepts(file, accept) && (maxSize == null || file.size <= maxSize));
    if (!multiple) arr = arr.slice(0, 1);
    setFiles(multiple ? [...files, ...arr] : arr);
  };
  const removeAt = (i: number) => setFiles(files.filter((_, idx) => idx !== i));

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  };

  return (
    <div className={cx("zr-file", className)}>
      <input
        ref={inputRef}
        id={field?.controlId ?? `${generatedId}-input`}
        type="file"
        className="zr-file__input"
        name={name}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        required={isRequired}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy}
        aria-errormessage={field?.errorId ?? rejectionId}
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
        }}
      />
      <div
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        aria-invalid={isInvalid || undefined}
        aria-describedby={describedBy}
        aria-errormessage={field?.errorId ?? rejectionId}
        className="zr-file__drop"
        data-over={over || undefined}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !disabled) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <Icon.Upload size={20} />
        <div className="zr-file__prompt">
          {over ? strings.fileRelease : multiple ? strings.filesDrop : strings.fileDrop}
        </div>
        {hint != null && <div className="z-hint">{hint}</div>}
      </div>
      {helper != null && (
        <div id={helperId} className="z-hint">
          {helper}
        </div>
      )}
      {rejection && (
        <div id={rejectionId} className="z-err" role="alert">
          {rejection}
        </div>
      )}
      {files.length > 0 && (
        <ul className="zr-file__list">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="zr-file__item">
              <Icon.File size={14} />
              <div className="zr-file__item-body">
                <div className="zr-truncate">{f.name}</div>
                <div className="zr-file__item-size">{formatFileSize(f.size, locale)}</div>
              </div>
              <button
                type="button"
                className="z-btn z-btn--ghost z-btn--sm z-btn--icon"
                aria-label={strings.removeFile(f.name)}
                onClick={() => removeAt(i)}
              >
                <Icon.X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
FileInput.displayName = "FileInput";
