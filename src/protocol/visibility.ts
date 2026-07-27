import type { Visibility } from "../schema/common.js";
import type { PlanStage } from "../schema/execution-plan.js";

export interface ArtifactAudience {
  readonly participantId: string;
  readonly participantRole?: string;
  readonly stage: Pick<PlanStage, "operator" | "role" | "visibility">;
}

export interface ArtifactIdentity {
  readonly participantId?: string;
  readonly role?: string;
}

function normalizeRole(role: string): string {
  return role.trim().toLowerCase();
}

function isDesignatedJudge(audience: ArtifactAudience): boolean {
  if (audience.stage.operator === "vote") return true;
  const roles = [audience.stage.role, audience.participantRole]
    .filter((role): role is string => typeof role === "string")
    .map(normalizeRole);
  return roles.some((role) => /\b(judge|juror|adjudicator)\b/u.test(role));
}

export function canReadArtifact(
  visibility: Visibility,
  identity: ArtifactIdentity,
  audience: ArtifactAudience,
): boolean {
  switch (visibility) {
    case "private":
      return identity.participantId === audience.participantId;
    case "role": {
      if (!identity.role) return false;
      const sourceRole = normalizeRole(identity.role);
      return [audience.participantRole, audience.stage.role]
        .filter((role): role is string => typeof role === "string")
        .some((role) => normalizeRole(role) === sourceRole);
    }
    case "judge-only":
      return isDesignatedJudge(audience);
    case "audit-only":
      return false;
    case "identity-stripped-council":
    case "council":
    case "public-result":
      return true;
  }
}

export function shouldStripArtifactIdentity(
  sourceVisibility: Visibility,
  destinationVisibility: Visibility,
): boolean {
  return (
    sourceVisibility === "identity-stripped-council" ||
    destinationVisibility === "identity-stripped-council"
  );
}
