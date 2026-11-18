/** Engine details supplied by the lyrics overlay to the voice control. */
export type StemEngine = {
  available: boolean;
  machine?: string;
  backend?: string;
  estimate: number | null;
};
