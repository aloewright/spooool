import { useParams } from '@tanstack/react-router';

import type { JSX } from "react";

// LEGAL-REVIEW: this is the public-facing notice page shown in place of a
// disabled video. Counsel must approve the wording before launch.

export function DmcaNotice(): JSX.Element {
  const { videoId } = useParams({ strict: false });
  return (
    <main className="app-main stack-lg">
      <h1 className="ds-h2">Unavailable for legal reasons</h1>
      {/* LEGAL-REVIEW: replace placeholder DMCA notice copy. */}
      <p className="ds-lede">
        This video has been disabled in response to a DMCA copyright notice. If you believe this was filed in error,
        you may submit a counter-notice.
      </p>
      <p className="ds-meta">
        Video reference: <code>{videoId}</code>
      </p>
    </main>
  );
}
