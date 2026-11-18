/* krobi-ui; AGPL-3.0; see LICENSE. */
import type { ReactElement, SVGProps } from "react";

/** the handful of lucide glyphs the components need. currentColor, 16 on controls,
 *  decorative by default (aria-hidden); always sit next to a text label. */
export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function make(children: ReactElement, name: string) {
  function Glyph({ size = 16, className, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        className={className ? `zr-icon ${className}` : "zr-icon"}
        {...rest}
      >
        {children}
      </svg>
    );
  }
  Glyph.displayName = `Icon.${name}`;
  return Glyph;
}

export const Icon = {
  X: make(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>, "X"),
  Upload: make(<><path d="M12 3v12" /><path d="m17 8-5-5-5 5" /><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /></>, "Upload"),
  File: make(<><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></>, "File"),
};
