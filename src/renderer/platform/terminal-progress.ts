/** A releasable UI lease whose owner may update its visible progress text. */
export type TerminalProgressHandle = (() => void) & {
  setLabel?: (label: string) => void;
};
