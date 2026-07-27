import type { SwitchConfig } from "../schema/config.js";
import {
  createDefaultSessionState,
  type ConfigSource,
  type SessionMode,
  type SessionState,
} from "../schema/session.js";
import { defaultHyperparams } from "../protocol/parameters.js";
import { resolveRoleBindings } from "../protocol/roles.js";
import type { CreateRunRequest } from "../runtime/run-service.js";

export interface SessionControllerOptions {
  readonly config: SwitchConfig;
  readonly initial?: Partial<SessionState>;
}

export class SessionController {
  private state: SessionState;

  constructor(private readonly options: SessionControllerOptions) {
    const defaultProfile = options.config.defaults.profile;
    this.state = {
      ...createDefaultSessionState(defaultProfile),
      ...options.initial,
    };
    this.applyDefaultProfile();
  }

  get snapshot(): SessionState {
    return this.state;
  }

  setMode(mode: SessionMode): void {
    this.state = {
      ...this.state,
      mode,
      planMode: mode === "plan",
      profileId:
        mode === "routed"
          ? "router-balanced"
          : mode === "direct"
            ? this.state.profileId
            : this.state.profileId === "router-balanced"
              ? this.options.config.defaults.profile
              : this.state.profileId,
    };
    if (this.state.configSource === "default") this.applyDefaultProfile();
  }

  setConfigSource(source: ConfigSource): void {
    this.state = { ...this.state, configSource: source };
    if (source === "default") this.applyDefaultProfile();
  }

  setProfile(profileId: string): void {
    if (!this.options.config.profiles[profileId]) {
      throw new Error(`Unknown profile ${profileId}`);
    }
    this.state = { ...this.state, profileId };
    if (this.state.configSource === "default") this.applyDefaultProfile();
    else {
      const profile = this.options.config.profiles[profileId];
      this.state = {
        ...this.state,
        mode:
          profile.mode === "routed"
            ? "routed"
            : profile.mode === "direct"
              ? "direct"
              : this.state.mode === "plan"
                ? "plan"
                : "council",
        ...(profile.protocol ? { protocolId: profile.protocol } : {}),
        participants: [...profile.participants],
        ...(profile.synthesizer ? { synthesizer: profile.synthesizer } : {}),
        ...(profile.router ? { routerParticipantId: profile.router } : {}),
        ...(profile.critiqueRounds !== undefined ? { critiqueRounds: profile.critiqueRounds } : {}),
      };
    }
  }

  setProtocol(protocolId: string): void {
    this.state = {
      ...this.state,
      protocolId,
      configSource: "manual",
      hyperparams: {
        ...defaultHyperparams(protocolId),
        ...(this.state.hyperparams ?? {}),
      },
    };
  }

  setParticipants(participants: readonly string[]): void {
    this.state = {
      ...this.state,
      participants: [...participants],
      configSource: "manual",
    };
  }

  setSynthesizer(synthesizer: string): void {
    this.state = { ...this.state, synthesizer, configSource: "manual" };
  }

  setCritiqueRounds(rounds: number): void {
    this.state = {
      ...this.state,
      critiqueRounds: rounds,
      configSource: "manual",
      hyperparams: { ...(this.state.hyperparams ?? {}), critiqueRounds: rounds },
    };
  }

  setRoleBindings(roleBindings: Readonly<Record<string, string>>): void {
    this.state = { ...this.state, roleBindings: { ...roleBindings }, configSource: "manual" };
  }

  setHyperparam(key: string, value: unknown): void {
    this.state = {
      ...this.state,
      configSource: "manual",
      hyperparams: { ...(this.state.hyperparams ?? {}), [key]: value },
      ...(key === "critiqueRounds" && typeof value === "number" ? { critiqueRounds: value } : {}),
    };
  }

  setGoal(goal: string): void {
    this.state = { ...this.state, goal };
  }

  setThinking(thinking: "low" | "medium" | "high"): void {
    this.state = { ...this.state, thinking };
  }

  setCollapsePolicy(policy: "collapsed" | "expanded"): void {
    this.state = { ...this.state, collapsePolicy: policy };
  }

  setAutoDecider(participantId: string): void {
    this.state = { ...this.state, autoDeciderParticipantId: participantId };
  }

  setRouter(participantId: string): void {
    this.state = { ...this.state, routerParticipantId: participantId };
  }

  togglePlanMode(): void {
    const planMode = !this.state.planMode;
    this.state = {
      ...this.state,
      planMode,
      mode: planMode ? "plan" : this.state.mode === "plan" ? "council" : this.state.mode,
    };
  }

  applyDefaultProfile(): void {
    const profile =
      this.options.config.profiles[this.state.profileId] ??
      this.options.config.profiles[this.options.config.defaults.profile];
    if (!profile) return;
    const protocolId = profile.protocol ?? "independent-critique-synthesis";
    this.state = {
      ...this.state,
      configSource: "default",
      mode:
        this.state.mode === "plan"
          ? "plan"
          : profile.mode === "routed"
            ? "routed"
            : profile.mode === "direct"
              ? "direct"
              : "council",
      protocolId,
      participants: [...profile.participants],
      ...(profile.synthesizer ? { synthesizer: profile.synthesizer } : {}),
      ...(profile.router ? { routerParticipantId: profile.router } : {}),
      ...(profile.critiqueRounds !== undefined ? { critiqueRounds: profile.critiqueRounds } : {}),
      hyperparams: defaultHyperparams(protocolId),
      autoDeciderParticipantId:
        this.state.autoDeciderParticipantId ??
        profile.synthesizer ??
        profile.participants[0] ??
        "codex-architect",
    };
  }

  applyAutoDecision(decision: {
    protocolId: string;
    participants: readonly string[];
    synthesizer?: string;
    critiqueRounds?: number;
    hyperparams?: Readonly<Record<string, unknown>>;
    roleBindings?: Readonly<Record<string, string>>;
  }): void {
    this.state = {
      ...this.state,
      configSource: "auto",
      protocolId: decision.protocolId,
      participants: [...decision.participants],
      ...(decision.synthesizer ? { synthesizer: decision.synthesizer } : {}),
      ...(decision.critiqueRounds !== undefined ? { critiqueRounds: decision.critiqueRounds } : {}),
      hyperparams: {
        ...defaultHyperparams(decision.protocolId),
        ...(decision.hyperparams ?? {}),
      },
      ...(decision.roleBindings ? { roleBindings: { ...decision.roleBindings } } : {}),
    };
  }

  /** Build a CreateRunRequest for council/direct/plan from current session. */
  toRunRequest(query: string): CreateRunRequest {
    const profile = this.options.config.profiles[this.state.profileId];
    let participants = this.state.participants ?? profile?.participants ?? [];
    let synthesizer = this.state.synthesizer ?? profile?.synthesizer;
    const protocolId =
      this.state.protocolId ?? profile?.protocol ?? "independent-critique-synthesis";

    if (this.state.roleBindings && Object.keys(this.state.roleBindings).length > 0) {
      const resolved = resolveRoleBindings(
        protocolId,
        this.state.roleBindings,
        participants,
        synthesizer,
      );
      participants = resolved.participants;
      synthesizer = resolved.synthesizer;
    }

    const goalPrefix = this.state.goal.trim() ? `Session goal: ${this.state.goal.trim()}\n\n` : "";
    const planPrefix =
      this.state.planMode || this.state.mode === "plan"
        ? "PLAN MODE: Produce a structured implementation plan with steps, risks, and acceptance criteria before any irreversible action.\n\n"
        : "";

    const critiqueRounds =
      this.state.critiqueRounds ??
      (typeof this.state.hyperparams?.["critiqueRounds"] === "number"
        ? this.state.hyperparams["critiqueRounds"]
        : profile?.critiqueRounds);

    const parameters: Record<string, unknown> = {
      ...(profile?.config ?? {}),
      ...(this.state.hyperparams ?? {}),
    };

    return {
      query: `${goalPrefix}${planPrefix}${query}`,
      profileId: this.state.profileId,
      protocolId:
        this.state.mode === "plan" || this.state.planMode
          ? "generator-critic-verifier"
          : protocolId,
      participants,
      ...(synthesizer ? { synthesizer } : {}),
      ...(critiqueRounds !== undefined ? { critiqueRounds } : {}),
      parameters,
    };
  }

  approachLabel(config: SwitchConfig): string {
    const protocolId = this.state.protocolId ?? config.profiles[this.state.profileId]?.protocol;
    return protocolId ?? "unknown";
  }
}
