import { Controller, Get } from '@nestjs/common';
import { METRICS, legacyMetrics, liveMetrics } from '@razorveda/metrics';

/**
 * Proves the certified metric layer is wired end to end.
 *
 * Only LIVE metrics are exposed. A legacy metric is recorded for the Phase 2
 * variance report and must never reach an API response (N8, D-38) — returning
 * METRICS wholesale here would be a containment-test failure, which is the point.
 */
@Controller('metrics')
export class MetricsController {
  @Get('registry')
  registry() {
    return {
      total: METRICS.length,
      live: liveMetrics().length,
      legacy: legacyMetrics().length,
      metrics: liveMetrics().map((m) => ({
        key: m.key,
        name: m.name,
        section: m.section,
        kind: m.kind,
        grain: m.grain,
        // Dials, connects and connectivity are claimed, not measured (D-03).
        // docs/04 requires the UI to label them, so the flag ships with the data.
        selfReported: m.selfReported ?? false,
      })),
    };
  }
}
