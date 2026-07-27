export interface ProtocolRoleSlot {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly multi: boolean;
  readonly required: boolean;
}

/** Named role slots for UI binding (participant → slot). */
export function roleSlotsForProtocol(protocolId: string): readonly ProtocolRoleSlot[] {
  switch (protocolId) {
    case "direct":
    case "human-gated-direct":
      return [
        {
          id: "primary",
          label: "Primary",
          description: "Single respondent",
          multi: false,
          required: true,
        },
      ];
    case "self-consistency":
      return [
        {
          id: "sampler",
          label: "Sampler",
          description: "Generates independent samples",
          multi: false,
          required: true,
        },
        {
          id: "synthesizer",
          label: "Synthesizer",
          description: "Aggregates samples",
          multi: false,
          required: true,
        },
      ];
    case "generator-critic-verifier":
      return [
        {
          id: "generator",
          label: "Generator",
          description: "Drafts and revises",
          multi: false,
          required: true,
        },
        {
          id: "critics",
          label: "Critics",
          description: "Inspect the draft",
          multi: true,
          required: true,
        },
        {
          id: "verifier",
          label: "Verifier",
          description: "Checks claims",
          multi: false,
          required: true,
        },
        {
          id: "synthesizer",
          label: "Synthesizer",
          description: "Final synthesis",
          multi: false,
          required: true,
        },
      ];
    case "courtroom":
      return [
        {
          id: "advocates",
          label: "Advocates",
          description: "Opening cases",
          multi: true,
          required: true,
        },
        {
          id: "judge",
          label: "Judge",
          description: "Ruling / synthesizer",
          multi: false,
          required: true,
        },
      ];
    case "cascade":
      return [
        {
          id: "primary",
          label: "Primary",
          description: "First-pass answer",
          multi: false,
          required: true,
        },
        {
          id: "verifier",
          label: "Verifier",
          description: "Checks primary answer",
          multi: false,
          required: true,
        },
        {
          id: "synthesizer",
          label: "Synthesizer",
          description: "Final answer",
          multi: false,
          required: true,
        },
      ];
    default:
      return [
        {
          id: "members",
          label: "Council members",
          description: "Parallel council participants",
          multi: true,
          required: true,
        },
        {
          id: "synthesizer",
          label: "Synthesizer",
          description: "Final synthesis / judge",
          multi: false,
          required: true,
        },
      ];
  }
}

/**
 * Expand roleBindings (slot → participant or comma-separated participants)
 * into ordered participant list + synthesizer for the compiler.
 */
export function resolveRoleBindings(
  protocolId: string,
  roleBindings: Readonly<Record<string, string>>,
  fallbackParticipants: readonly string[],
  fallbackSynthesizer?: string,
): { participants: string[]; synthesizer: string } {
  const slots = roleSlotsForProtocol(protocolId);
  const ordered: string[] = [];
  let synthesizer = fallbackSynthesizer ?? fallbackParticipants[0] ?? "";

  for (const slot of slots) {
    const raw = roleBindings[slot.id]?.trim();
    if (!raw) continue;
    const ids = raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (slot.id === "synthesizer" || slot.id === "judge") {
      synthesizer = ids[0] ?? synthesizer;
      continue;
    }
    for (const id of ids) {
      if (!ordered.includes(id)) ordered.push(id);
    }
  }

  if (ordered.length === 0) ordered.push(...fallbackParticipants);
  if (!synthesizer) synthesizer = ordered[0] ?? fallbackParticipants[0] ?? "";
  if (synthesizer && !ordered.includes(synthesizer) && protocolId !== "courtroom") {
    // synthesizer may also be a member for most protocols
  }
  return { participants: ordered, synthesizer };
}
