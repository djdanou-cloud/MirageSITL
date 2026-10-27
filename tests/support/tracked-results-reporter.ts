import type { FullResult, Reporter } from "@playwright/test/reporter";
import { trackedResults } from "./tracked-results";

/**
 * Browser counterpart of the Vitest global setup in ./tracked-results. Playwright runs global
 * teardown before reporters finish, so a teardown never sees the JUnit or HTML report being
 * written. Listed last, this reporter rechecks tracked test-results/ files after every other
 * reporter is done and fails a run that changed them.
 */
export default class TrackedResultsReporter implements Reporter {
  // Reporters are constructed before Playwright clears its output directory or starts the web server.
  private readonly before = trackedResults();

  printsToStdio(): boolean {
    return false;
  }

  onEnd(result: FullResult): Promise<{ status: FullResult["status"] } | undefined> {
    const failure = this.failure();
    if (failure !== undefined) console.error(failure);
    // Playwright only logs an error thrown by a reporter; the returned status is what fails the run.
    return Promise.resolve(failure !== undefined && result.status === "passed" ? { status: "failed" } : undefined);
  }

  private failure(): string | undefined {
    try {
      const after = trackedResults();
      if (after === this.before) return undefined;
      return `Browser tests changed tracked files under test-results/ (git status --porcelain -- test-results/).\nBefore:\n${this.before || "(clean)"}\nAfter:\n${after || "(clean)"}`;
    } catch (error) {
      return `Could not recheck tracked files under test-results/: ${String(error)}`;
    }
  }
}
