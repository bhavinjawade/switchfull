import type { RunRepository } from "../persistence/run-repository.js";
import type { ExecuteOptions, ExecutionResult } from "../runtime/executor.js";
import type { RunService } from "../runtime/run-service.js";
import type { RouteRequest, RouteResult, RouterService } from "./router-service.js";

export interface RoutedExecutionResult extends ExecutionResult {
  readonly route: RouteResult;
}

export class RoutedRunOrchestrator {
  constructor(
    private readonly router: RouterService,
    private readonly runs: RunService,
    private readonly repository: RunRepository,
  ) {}

  async run(request: RouteRequest, options: ExecuteOptions): Promise<RoutedExecutionResult> {
    const route = await this.router.route(request);
    const run = this.runs.create({
      query: request.query,
      profileId: route.session.profileId,
      plan: route.decision.proposedPlan,
    });
    this.repository.appendEvent(
      run.id,
      "RoutingRequested",
      {
        routerSessionId: route.session.id,
        routerParticipantId: route.session.routerParticipantId,
      },
      "switch.router",
    );
    this.repository.recordRoutingDecision(run.id, route.decision, {
      outcome: route.validation.outcome,
      violations: route.validation.violations,
      estimatedCalls: route.validation.estimatedCalls,
    });
    const result = await this.runs.execute(run.id, options);
    return { ...result, route };
  }
}
