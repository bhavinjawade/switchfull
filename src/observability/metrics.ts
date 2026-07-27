import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export class SwitchMetrics {
  readonly registry = new Registry();
  readonly runs = new Counter({
    name: "switch_runs_total",
    help: "Switch runs created by mode.",
    labelNames: ["mode"],
    registers: [this.registry],
  });
  readonly activeRuns = new Gauge({
    name: "switch_active_runs",
    help: "Switch runs currently executing.",
    registers: [this.registry],
  });
  readonly runDuration = new Histogram({
    name: "switch_run_duration_seconds",
    help: "End-to-end run duration.",
    labelNames: ["mode", "status"],
    buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1_800],
    registers: [this.registry],
  });
  readonly routing = new Counter({
    name: "switch_routing_decisions_total",
    help: "Routing decisions by source and strategy.",
    labelNames: ["source", "strategy"],
    registers: [this.registry],
  });

  constructor(collectProcessMetrics = true) {
    if (collectProcessMetrics) collectDefaultMetrics({ register: this.registry });
  }
}
