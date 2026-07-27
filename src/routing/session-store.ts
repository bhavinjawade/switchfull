import { createRouterSessionId, type RouterSessionId } from "../domain/ids.js";
import type { Budget } from "../schema/common.js";
import type { SwitchDatabase } from "../persistence/database.js";

export type RoutingScope = "request" | "conversation" | "workspace" | "explicit";

export interface RouterHistoryItem {
  readonly timestamp: string;
  readonly querySummary: string;
  readonly strategy: string;
  readonly selectedParticipants: readonly string[];
  readonly outcome?: "accepted" | "fallback";
  readonly fallbackReason?: string;
}

export interface RouterSessionRecord {
  readonly id: RouterSessionId;
  readonly routerParticipantId: string;
  readonly profileId: string;
  readonly scope: RoutingScope;
  readonly eligibleParticipants: readonly string[];
  readonly budget: Budget;
  readonly history: readonly RouterHistoryItem[];
  readonly summary: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RouterSessionRow {
  readonly id: string;
  readonly router_participant_id: string;
  readonly profile_id: string;
  readonly scope: RoutingScope;
  readonly eligible_participants_json: string;
  readonly budget_json: string;
  readonly history_json: string;
  readonly summary: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function toRecord(row: RouterSessionRow): RouterSessionRecord {
  return {
    id: row.id as RouterSessionId,
    routerParticipantId: row.router_participant_id,
    profileId: row.profile_id,
    scope: row.scope,
    eligibleParticipants: JSON.parse(row.eligible_participants_json) as string[],
    budget: JSON.parse(row.budget_json) as Budget,
    history: JSON.parse(row.history_json) as RouterHistoryItem[],
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RouterSessionStore {
  constructor(private readonly database: SwitchDatabase) {}

  create(input: {
    readonly routerParticipantId: string;
    readonly profileId: string;
    readonly scope: RoutingScope;
    readonly eligibleParticipants: readonly string[];
    readonly budget: Budget;
  }): RouterSessionRecord {
    const id = createRouterSessionId();
    const timestamp = new Date().toISOString();
    this.database.raw
      .prepare(
        `INSERT INTO router_sessions(
          id, router_participant_id, profile_id, scope, eligible_participants_json,
          budget_json, history_json, summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, '[]', '', ?, ?)`,
      )
      .run(
        id,
        input.routerParticipantId,
        input.profileId,
        input.scope,
        JSON.stringify(input.eligibleParticipants),
        JSON.stringify(input.budget),
        timestamp,
        timestamp,
      );
    return this.get(id);
  }

  get(id: RouterSessionId): RouterSessionRecord {
    const row = this.database.raw.prepare("SELECT * FROM router_sessions WHERE id = ?").get(id) as
      RouterSessionRow | undefined;
    if (!row) throw new Error(`Router session ${id} does not exist.`);
    return toRecord(row);
  }

  append(id: RouterSessionId, item: RouterHistoryItem, summary: string): RouterSessionRecord {
    const session = this.get(id);
    const history = [...session.history, item].slice(-20);
    this.database.raw
      .prepare(
        "UPDATE router_sessions SET history_json = ?, summary = ?, updated_at = ? WHERE id = ?",
      )
      .run(JSON.stringify(history), summary, new Date().toISOString(), id);
    return this.get(id);
  }
}
