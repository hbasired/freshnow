import { Component, type ReactNode } from "react";
import { Card } from "./ui";

/**
 * A portal that cannot be loaded or drawn says so, and offers a reload (TASK-058 review).
 *
 * Projects and Operations are separate code chunks, fetched when first opened. After an update the
 * chunk names the page was built with are gone, and a dropped connection fails the same way. Without
 * a boundary React unmounts the whole app on that error and leaves a blank page — on a phone running
 * the installed app, one with no reload button anywhere.
 */
export class PortalBoundary extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Card>
        <p className="font-semibold">{this.props.name} could not be opened.</p>
        <p className="mt-1 text-sm text-mut">The app may have been updated, or the connection dropped. Reload to get the latest version.</p>
        <button
          onClick={() => location.reload()}
          className="mt-3 rounded-xl border border-edge bg-sunken px-3 py-2 text-sm font-semibold hover:border-link"
        >
          Reload
        </button>
      </Card>
    );
  }
}
