import type { ReactNode } from "react";
/** Permission/network feedback must be announced once; never launches retries. */
export function StatusMessage({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <span role={error ? "alert" : "status"} aria-atomic="true" className="status-message">{children}</span>;
}
