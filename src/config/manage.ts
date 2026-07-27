import type { ParticipantConfig, ProfileConfig, SwitchConfig } from "../schema/config.js";

export interface ParticipantPatch {
  readonly enabled?: boolean;
  readonly connector?: string;
  readonly model?: string;
  readonly displayName?: string;
  readonly role?: string;
  readonly mandate?: string;
  readonly expertise?: readonly string[];
  readonly tags?: readonly string[];
}

export interface ProfilePatch {
  readonly label?: string;
  readonly description?: string;
  readonly mode?: ProfileConfig["mode"];
  readonly protocol?: string;
  readonly participants?: readonly string[];
  readonly synthesizer?: string;
  readonly router?: string;
  readonly critiqueRounds?: number;
}

function participant(config: SwitchConfig, id: string): ParticipantConfig {
  const value = config.participants[id];
  if (!value) throw new Error(`Unknown participant ${id}.`);
  return value;
}

function profile(config: SwitchConfig, id: string): ProfileConfig {
  const value = config.profiles[id];
  if (!value) throw new Error(`Unknown profile ${id}.`);
  return value;
}

function assertParticipantReferences(
  config: SwitchConfig,
  participantIds: readonly string[],
): void {
  if (participantIds.length === 0) throw new Error("A profile requires at least one participant.");
  for (const id of participantIds) participant(config, id);
}

export function updateParticipant(
  config: SwitchConfig,
  id: string,
  patch: ParticipantPatch,
): SwitchConfig {
  const current = participant(config, id);
  if (patch.connector && !config.connectors[patch.connector]) {
    throw new Error(`Unknown connector ${patch.connector}.`);
  }
  const updated: ParticipantConfig = {
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.connector ? { connector: patch.connector } : {}),
    ...(patch.model ? { model: patch.model } : {}),
    ...(patch.displayName ? { displayName: patch.displayName } : {}),
    ...(patch.role ? { role: patch.role } : {}),
    ...(patch.mandate !== undefined ? { mandate: patch.mandate } : {}),
    ...(patch.expertise ? { expertise: [...new Set(patch.expertise)] } : {}),
    ...(patch.tags ? { tags: [...new Set(patch.tags)] } : {}),
  };
  return {
    ...config,
    participants: { ...config.participants, [id]: updated },
  };
}

export function cloneParticipant(
  config: SwitchConfig,
  sourceId: string,
  targetId: string,
  patch: ParticipantPatch = {},
): SwitchConfig {
  if (config.participants[targetId]) throw new Error(`Participant ${targetId} already exists.`);
  const source = participant(config, sourceId);
  const cloned: SwitchConfig = {
    ...config,
    participants: {
      ...config.participants,
      [targetId]: {
        ...source,
        displayName: `${source.displayName} Copy`,
      },
    },
  };
  return updateParticipant(cloned, targetId, patch);
}

export function updateProfile(config: SwitchConfig, id: string, patch: ProfilePatch): SwitchConfig {
  const current = profile(config, id);
  const participants = patch.participants ?? current.participants;
  assertParticipantReferences(config, participants);
  const updated: ProfileConfig = {
    ...current,
    ...(patch.label ? { label: patch.label } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.mode ? { mode: patch.mode } : {}),
    ...(patch.protocol ? { protocol: patch.protocol } : {}),
    ...(patch.participants ? { participants: [...new Set(patch.participants)] } : {}),
    ...(patch.synthesizer ? { synthesizer: patch.synthesizer } : {}),
    ...(patch.router ? { router: patch.router } : {}),
    ...(patch.critiqueRounds !== undefined ? { critiqueRounds: patch.critiqueRounds } : {}),
  };
  if (updated.synthesizer && !updated.participants.includes(updated.synthesizer)) {
    delete updated.synthesizer;
  }
  if (updated.synthesizer) participant(config, updated.synthesizer);
  if (updated.router) participant(config, updated.router);
  return {
    ...config,
    profiles: { ...config.profiles, [id]: updated },
  };
}

export function cloneProfile(
  config: SwitchConfig,
  sourceId: string,
  targetId: string,
  patch: ProfilePatch = {},
): SwitchConfig {
  if (config.profiles[targetId]) throw new Error(`Profile ${targetId} already exists.`);
  const source = profile(config, sourceId);
  const cloned: SwitchConfig = {
    ...config,
    profiles: {
      ...config.profiles,
      [targetId]: {
        ...source,
        label: `${source.label} Copy`,
      },
    },
  };
  return updateProfile(cloned, targetId, patch);
}
