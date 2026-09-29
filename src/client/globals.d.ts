// Browser scripts are plain files, not modules, so what they share goes on `window`.

interface Window {
  /** Set by the inlined tab script; the review client uses it to reveal a target in another tab. */
  coplan?: {
    selectTab(id: string, options?: { updateHash?: boolean }): string;
  };
}
