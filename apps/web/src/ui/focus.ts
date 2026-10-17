export interface FocusTarget {
  readonly isConnected: boolean;
  readonly ownerDocument: { readonly activeElement: unknown; readonly body: unknown };
  focus(): void;
}
/** Restore a permission trigger without stealing focus moved intentionally by the user. */
export async function withFocusReturn(target: FocusTarget, action: () => Promise<void>): Promise<void> {
  try { await action(); }
  finally {
    const active = target.ownerDocument.activeElement;
    if (target.isConnected && (active === target || active === target.ownerDocument.body || active === null)) target.focus();
  }
}
