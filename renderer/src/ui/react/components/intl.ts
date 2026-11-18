/* krobi-ui; AGPL-3.0; see LICENSE. */
export function formatFileSize(bytes: number, locale: string) {
  const value = bytes < 1024 ? bytes : bytes < 1024 * 1024 ? bytes / 1024 : bytes / 1024 / 1024;
  const unit = bytes < 1024 ? "byte" : bytes < 1024 * 1024 ? "kilobyte" : "megabyte";
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit,
    unitDisplay: "short",
    maximumFractionDigits: unit === "megabyte" ? 2 : 1,
  }).format(value);
}
