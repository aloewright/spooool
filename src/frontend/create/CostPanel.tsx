// Static cost / model panel shown above the /create form. Lets the user
// see what they're about to spend and which AI Gateway routes power each
// stage of the toolchain. Patterned on OpenMontage's published-rates UX.

import { STAGE_COSTS, totalEstimateUsd, formatUsd } from './lib/cost-estimates';

interface CostPanelProps { collapsed?: boolean }

export function CostPanel({ collapsed }: CostPanelProps): JSX.Element {
  if (collapsed) {
    return (
      <p className="alert alert--info" style={{ marginBottom: 0 }}>
        Estimated cost per video: <strong>{formatUsd(totalEstimateUsd())}</strong> — expand for breakdown.
      </p>
    );
  }
  return (
    <details className="card card--tight" open>
      <summary style={{ cursor: 'pointer', fontWeight: 500 }}>
        Models &amp; cost — about {formatUsd(totalEstimateUsd())} per 60–90s video
      </summary>
      <table className="info-table" style={{ marginTop: 12 }}>
        <thead>
          <tr>
            <th>Stage</th>
            <th>Route</th>
            <th>Resolved model</th>
            <th className="num">~Cost</th>
          </tr>
        </thead>
        <tbody>
          {STAGE_COSTS.map((s) => (
            <tr key={s.stage}>
              <td><code>{s.stage}</code><br /><span style={{ color: 'var(--muted-foreground)' }}>{s.description}</span></td>
              <td><code>{s.route}</code></td>
              <td>{s.resolvedModel}</td>
              <td className="num">{formatUsd(s.costUsd)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={3}><strong>Estimated total</strong></td>
            <td className="num"><strong>{formatUsd(totalEstimateUsd())}</strong></td>
          </tr>
        </tbody>
      </table>
      <p style={{ fontSize: 'var(--text-xs)', color: 'var(--muted-foreground)', marginTop: 8 }}>
        Estimates are static snapshots of typical per-call cost on the configured AI Gateway
        routes — actual cost depends on the route's resolved provider chain and any cache hits
        recorded in your AI Gateway dashboard.
      </p>
    </details>
  );
}
