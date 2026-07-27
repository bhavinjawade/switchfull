import { randomUUID } from "node:crypto";
import { stdin as input, stdout as output } from "node:process";
import { emitKeypressEvents } from "node:readline";
import type { SwitchRuntime } from "../application/runtime.js";
import { SessionController } from "../application/session-controller.js";
import { SetupService } from "../application/setup-service.js";
import { SWITCH_VERSION } from "../domain/version.js";
import { approachPaper } from "../protocol/papers.js";
import { ProtocolRegistry } from "../protocol/registry.js";
import { AutoDecider } from "../routing/auto-decider.js";
import { RoutedRunOrchestrator } from "../routing/orchestrator.js";
import type { RunProgress } from "../runtime/executor.js";
import { ToolHost } from "../tools/host.js";
import { ansi } from "./ansi.js";
import { openUrl } from "./open-url.js";
import { renderFrame } from "./render.js";
import {
  emptyUsage,
  type ApproachInfo,
  type RailMember,
  type StreamEntry,
  type TuiModel,
  type UsageTotals,
} from "./types.js";

export interface TuiOptions {
  readonly runtime: SwitchRuntime;
  readonly cwd?: string;
}

export async function runTui(options: TuiOptions): Promise<void> {
  const app = new SwitchTui(options);
  await app.start();
}

class SwitchTui {
  private readonly runtime: SwitchRuntime;
  private readonly cwd: string;
  private readonly session: SessionController;
  private readonly setup: SetupService;
  private readonly tools: ToolHost;
  private readonly protocols = new ProtocolRegistry();
  private model: TuiModel;
  private running = true;
  private busy = false;
  private abort: AbortController | undefined;
  private rawMode = false;

  constructor(options: TuiOptions) {
    this.runtime = options.runtime;
    this.cwd = options.cwd ?? process.cwd();
    this.session = new SessionController({ config: options.runtime.loadedConfig.config });
    this.setup = new SetupService(
      options.runtime.loadedConfig.config,
      options.runtime.registry,
      process.env,
    );
    this.tools = new ToolHost({ workspaceRoot: this.cwd, allowNetwork: false });
    this.model = {
      screen: "splash",
      session: this.session.snapshot,
      input: "",
      entries: [],
      scroll: 0,
      setupIndex: 0,
      setupStatuses: [],
      protocolIndex: 0,
      councilFocus: 0,
      running: false,
      live: {},
      usage: emptyUsage(),
      statusLine: `switch ${SWITCH_VERSION}`,
      cwd: this.cwd,
      width: output.columns || 100,
      height: output.rows || 30,
      railMembers: [],
      approach: { id: "", name: "—" },
    };
    this.syncRail();
  }

  private syncRail(): void {
    const snap = this.session.snapshot;
    const config = this.runtime.loadedConfig.config;
    const ids = snap.participants ?? [];
    const members: RailMember[] = ids.map((id) => {
      const p = config.participants[id];
      return {
        id,
        displayName: p?.displayName ?? id,
        role: p?.role ?? p?.kind ?? "member",
        model: p?.model?.trim() ? p.model : "(connector default)",
        connector: p?.connector ?? "?",
        isSynthesizer: id === snap.synthesizer,
        isRouter: id === snap.routerParticipantId,
      };
    });
    // Ensure synthesizer appears even if not in members list
    if (snap.synthesizer && !members.some((m) => m.id === snap.synthesizer)) {
      const p = config.participants[snap.synthesizer];
      members.push({
        id: snap.synthesizer,
        displayName: p?.displayName ?? snap.synthesizer,
        role: p?.role ?? "Synthesizer",
        model: p?.model?.trim() ? p.model : "(connector default)",
        connector: p?.connector ?? "?",
        isSynthesizer: true,
        isRouter: snap.synthesizer === snap.routerParticipantId,
      });
    }

    const protocolId = snap.protocolId ?? config.profiles[snap.profileId]?.protocol ?? "";
    let approach: ApproachInfo = { id: protocolId, name: protocolId || "—" };
    if (protocolId) {
      try {
        const meta = this.protocols.get(protocolId).metadata;
        const paper = approachPaper(protocolId);
        approach = {
          id: meta.id,
          name: meta.name,
          ...(paper
            ? { paperTitle: paper.title, paperUrl: paper.url }
            : meta.citations[0]
              ? { paperUrl: meta.citations[0], paperTitle: meta.citations[0] }
              : {}),
        };
      } catch {
        // keep id-only
      }
    }
    this.model.railMembers = members;
    this.model.approach = approach;
  }

  async start(): Promise<void> {
    if (!input.isTTY || !output.isTTY) {
      throw new Error(
        "Switch TUI requires an interactive TTY. Use `switch ask` for non-interactive runs.",
      );
    }
    output.write(ansi.altOn + ansi.hideCursor + ansi.clear + ansi.home);
    this.rawMode = true;
    emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();

    const onResize = (): void => {
      this.model.width = output.columns || 100;
      this.model.height = output.rows || 30;
      this.paint();
    };
    output.on("resize", onResize);

    const onKey = (
      chunk: string,
      key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string } | undefined,
    ): void => {
      void this.handleKey(chunk, key);
    };
    input.on("keypress", onKey);

    this.paint();

    await new Promise<void>((resolve) => {
      const tick = (): void => {
        if (!this.running) {
          cleanup();
          resolve();
          return;
        }
        setTimeout(tick, 100);
      };
      const cleanup = (): void => {
        input.off("keypress", onKey);
        output.off("resize", onResize);
        if (this.rawMode && input.isTTY) input.setRawMode(false);
        output.write(ansi.showCursor + ansi.altOff);
      };
      tick();
    });
  }

  private paint(): void {
    this.syncRail();
    this.model = {
      ...this.model,
      session: this.session.snapshot,
      width: output.columns || 100,
      height: output.rows || 30,
    };
    // Clear before every frame so shorter screens cannot leave splash/setup text behind.
    output.write(ansi.clear + ansi.home + renderFrame(this.model));
  }

  private openApproachPaper(protocolId?: string): void {
    const id = protocolId?.trim() ?? this.session.snapshot.protocolId ?? this.model.approach.id;
    if (!id) {
      this.pushSystem("No approach selected. Use /protocol <id> or /protocols first.");
      this.paint();
      return;
    }
    const paper = approachPaper(id);
    let url = paper?.url;
    if (!url) {
      try {
        url = this.protocols.get(id).metadata.citations[0];
      } catch {
        this.pushSystem(`Unknown approach ${id}.`);
        this.paint();
        return;
      }
    }
    if (!url) {
      this.pushSystem(`Approach ${id} has no paper citation yet.`);
      this.paint();
      return;
    }
    const result = openUrl(url);
    this.pushSystem(
      result.ok
        ? `Opening paper for ${paper?.protocolName ?? id}:\n${paper?.title ?? url}\n${url}`
        : `Could not open browser: ${result.message}\nPaper: ${url}`,
    );
    this.model.statusLine = result.ok ? `Opened paper · ${id}` : result.message;
    this.paint();
  }

  private async handleKey(
    chunk: string,
    key: { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string } | undefined,
  ): Promise<void> {
    if (!this.running) return;
    if (key?.ctrl && key.name === "c") {
      this.abort?.abort();
      this.running = false;
      return;
    }

    if (this.model.screen === "splash") {
      if (key?.name === "return" || key?.name === "enter") {
        this.model.screen = "main";
        this.paint();
        return;
      }
      if (chunk === "s" || chunk === "S") {
        await this.openSetup();
        return;
      }
      if (chunk === "?" || chunk === "h") {
        this.model.screen = "help";
        this.paint();
        return;
      }
      if (chunk === "q" || chunk === "Q") {
        this.running = false;
        return;
      }
      return;
    }

    if (this.model.screen === "setup") {
      await this.handleSetupKey(key, chunk);
      return;
    }
    if (this.model.screen === "help") {
      if (key?.name === "escape" || chunk === "q") {
        this.model.screen = "main";
        this.paint();
      }
      return;
    }
    if (this.model.screen === "protocols") {
      await this.handleProtocolKey(key, chunk);
      return;
    }
    if (this.model.screen === "council") {
      if (key?.name === "escape" || chunk === "q") {
        this.model.screen = "main";
        this.paint();
      }
      return;
    }

    // main
    if (key?.name === "escape") {
      this.model.input = "";
      this.paint();
      return;
    }
    if (key?.name === "tab") {
      this.toggleLastCollapse();
      this.paint();
      return;
    }
    if (key?.name === "backspace") {
      this.model.input = this.model.input.slice(0, -1);
      this.paint();
      return;
    }
    if (key?.name === "return" || key?.name === "enter") {
      const text = this.model.input.trim();
      this.model.input = "";
      this.paint();
      if (!text) return;
      if (text.startsWith("/")) {
        await this.handleSlash(text);
      } else {
        await this.runQuery(text);
      }
      return;
    }
    if (key?.name === "up") {
      this.model.scroll = Math.max(0, this.model.scroll - 1);
      this.paint();
      return;
    }
    if (key?.name === "down") {
      this.model.scroll += 1;
      this.paint();
      return;
    }
    if (key?.ctrl || key?.meta) return;
    if (chunk?.length === 1 && chunk >= " ") {
      this.model.input += chunk;
      this.paint();
    } else if (chunk?.length > 1 && !key?.name) {
      // paste
      this.model.input += chunk.replace(/[\r\n]/g, " ");
      this.paint();
    }
  }

  private async handleSetupKey(key: { name?: string } | undefined, chunk: string): Promise<void> {
    if (key?.name === "escape") {
      this.model.screen = "main";
      this.paint();
      return;
    }
    if (key?.name === "up") {
      this.model.setupIndex = Math.max(0, this.model.setupIndex - 1);
      this.paint();
      return;
    }
    if (key?.name === "down") {
      this.model.setupIndex = Math.min(
        Math.max(0, this.model.setupStatuses.length - 1),
        this.model.setupIndex + 1,
      );
      this.paint();
      return;
    }
    if (chunk === "r" || chunk === "R") {
      await this.refreshSetup();
      return;
    }
    const current = this.model.setupStatuses[this.model.setupIndex];
    if (!current) return;
    if (key?.name === "return" || key?.name === "enter") {
      try {
        const binaryPath = current.detail.includes("/") ? current.detail.split(" ")[0] : undefined;
        const next = this.setup.enableProvider(current.id, binaryPath);
        const path = this.setup.persist(next);
        this.pushSystem(
          `Enabled ${current.label}. Saved ${path}. Restart TUI to reload registry fully.`,
        );
        this.model.statusLine = `Enabled ${current.id}`;
        await this.refreshSetup();
      } catch (error) {
        this.model.statusLine = error instanceof Error ? error.message : String(error);
        this.paint();
      }
      return;
    }
    if (chunk === "d" || chunk === "D") {
      try {
        const next = this.setup.disableProvider(current.id);
        this.setup.persist(next);
        this.model.statusLine = `Disabled ${current.id}`;
        await this.refreshSetup();
      } catch (error) {
        this.model.statusLine = error instanceof Error ? error.message : String(error);
        this.paint();
      }
      return;
    }
    if (chunk === "l" || chunk === "L") {
      this.model.statusLine = `Launching login for ${current.id}… (may fail if CLI has no login subcommand)`;
      this.paint();
      // Temporarily leave raw mode so login CLI can use TTY
      if (input.isTTY) input.setRawMode(false);
      output.write(ansi.showCursor + ansi.altOff + "\n");
      const result = await this.setup.runOfficialLogin(current.id);
      output.write(`${result.message}\nPress Enter to return…`);
      await waitForEnter();
      output.write(ansi.altOn + ansi.hideCursor);
      if (input.isTTY) input.setRawMode(true);
      this.model.statusLine = result.message;
      await this.refreshSetup();
    }
  }

  private async handleProtocolKey(
    key: { name?: string } | undefined,
    chunk?: string,
  ): Promise<void> {
    if (key?.name === "escape") {
      this.model.screen = "main";
      this.paint();
      return;
    }
    if (key?.name === "up") {
      this.model.protocolIndex = Math.max(0, this.model.protocolIndex - 1);
      this.paint();
      return;
    }
    if (key?.name === "down") {
      this.model.protocolIndex = Math.min(
        Math.max(0, this.model.setupStatuses.length - 1),
        this.model.protocolIndex + 1,
      );
      this.paint();
      return;
    }
    if (chunk === "o" || chunk === "O") {
      const item = this.model.setupStatuses[this.model.protocolIndex];
      if (item?.paperUrl) {
        const result = openUrl(item.paperUrl);
        this.model.statusLine = result.ok ? `Opened paper for ${item.id}` : result.message;
        this.paint();
      } else if (item) {
        this.openApproachPaper(item.id);
      }
      return;
    }
    if (key?.name === "return" || key?.name === "enter") {
      const item = this.model.setupStatuses[this.model.protocolIndex];
      if (item) {
        this.session.setProtocol(item.id);
        this.session.setConfigSource("manual");
        const paper = approachPaper(item.id);
        this.pushSystem(
          `Approach set to ${item.label} (${item.id}).` +
            (paper
              ? `\nPaper: ${paper.title}\n${paper.url}\nTip: /paper opens it in your browser.`
              : ""),
        );
        this.model.screen = "main";
        this.paint();
      }
    }
  }

  private async openSetup(): Promise<void> {
    this.model.screen = "setup";
    await this.refreshSetup();
  }

  private async refreshSetup(): Promise<void> {
    const statuses = await this.setup.status(this.cwd);
    this.model.setupStatuses = statuses.map((s) => ({
      id: s.provider.id,
      label: s.provider.label,
      status:
        s.access === "available"
          ? s.enabled
            ? "available"
            : "disabled"
          : s.access === "unauthenticated"
            ? "unauthenticated"
            : (s.health?.status ?? (s.binaryFound ? "installed" : "unavailable")),
      detail: s.binaryPath
        ? `${s.binaryPath} · ${s.remediation}`
        : s.envPresent === false
          ? `env missing · ${s.remediation}`
          : s.remediation,
    }));
    this.paint();
  }

  private openProtocols(): void {
    this.model.screen = "protocols";
    this.model.setupStatuses = this.protocols.list().map((meta) => {
      const paper = approachPaper(meta.id);
      return {
        id: meta.id,
        label: meta.name,
        status: meta.status,
        detail: paper ? `${meta.description} · ${paper.title}` : meta.description,
        ...(paper?.url
          ? { paperUrl: paper.url }
          : meta.citations[0]
            ? { paperUrl: meta.citations[0] }
            : {}),
      };
    });
    this.model.protocolIndex = Math.max(
      0,
      this.model.setupStatuses.findIndex((p) => p.id === this.session.snapshot.protocolId),
    );
    this.paint();
  }

  private toggleLastCollapse(): void {
    for (let i = this.model.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.model.entries[i];
      if (!entry) continue;
      if (entry.kind === "stage" || entry.kind === "invocation" || entry.kind === "tool") {
        this.model.entries[i] = { ...entry, collapsed: !entry.collapsed };
        return;
      }
    }
  }

  private pushEntry(entry: Omit<StreamEntry, "id" | "timestamp">): void {
    this.model.entries.push({
      ...entry,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    });
    this.model.scroll = 0;
  }

  private pushSystem(body: string): void {
    this.pushEntry({ kind: "system", title: "system", body, collapsed: false });
  }

  private async handleSlash(text: string): Promise<void> {
    const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd?.toLowerCase()) {
      case "help":
      case "?":
        this.model.screen = "help";
        break;
      case "setup":
        await this.openSetup();
        return;
      case "quit":
      case "exit":
        this.running = false;
        return;
      case "clear":
        this.model.entries = [];
        this.model.usage = emptyUsage();
        break;
      case "mode": {
        const mode = arg as "council" | "routed" | "direct" | "plan";
        if (!["council", "routed", "direct", "plan"].includes(mode)) {
          this.pushSystem("Usage: /mode council|routed|direct|plan");
          break;
        }
        this.session.setMode(mode);
        this.pushSystem(`Mode → ${mode}`);
        break;
      }
      case "config": {
        const source = arg as "manual" | "default" | "auto";
        if (!["manual", "default", "auto"].includes(source)) {
          this.pushSystem("Usage: /config manual|default|auto");
          break;
        }
        this.session.setConfigSource(source);
        if (source === "default") this.pushSystem("Reset to default council settings.");
        else if (source === "auto") {
          this.pushSystem(
            "Auto mode: the auto-decider LLM will choose approach/roles/params per query.",
          );
        } else {
          this.pushSystem("Manual mode: use /protocol, /rounds, /council to configure.");
        }
        break;
      }
      case "profile":
        if (!arg) {
          this.pushSystem(
            `Profiles: ${Object.keys(this.runtime.loadedConfig.config.profiles).join(", ")}`,
          );
          break;
        }
        try {
          this.session.setProfile(arg);
          this.pushSystem(`Profile → ${arg}`);
        } catch (error) {
          this.pushSystem(error instanceof Error ? error.message : String(error));
        }
        break;
      case "council":
        this.model.screen = "council";
        break;
      case "protocols":
        this.openProtocols();
        return;
      case "paper":
        this.openApproachPaper(arg || undefined);
        return;
      case "protocol":
        if (!arg) {
          const lines = this.protocols.list().map((p) => {
            const paper = approachPaper(p.id);
            return `${p.id.padEnd(32)} ${p.name}${paper ? ` · ${paper.url}` : ""}`;
          });
          this.pushSystem(lines.join("\n"));
          break;
        }
        try {
          this.protocols.get(arg);
          this.session.setProtocol(arg);
          const paper = approachPaper(arg);
          this.pushSystem(
            `Approach → ${arg}` +
              (paper ? `\n${paper.title}\n${paper.url}\nUse /paper to open.` : ""),
          );
        } catch (error) {
          this.pushSystem(error instanceof Error ? error.message : String(error));
        }
        break;
      case "rounds": {
        const n = Number.parseInt(arg, 10);
        if (!Number.isFinite(n)) {
          this.pushSystem("Usage: /rounds <0-10>");
          break;
        }
        this.session.setCritiqueRounds(n);
        this.pushSystem(`Critique rounds → ${n}`);
        break;
      }
      case "goal":
        this.session.setGoal(arg);
        this.pushSystem(arg ? `Goal set.` : "Goal cleared.");
        break;
      case "router":
        if (!arg) {
          this.pushSystem("Usage: /router <participant-id>");
          break;
        }
        this.session.setRouter(arg);
        this.pushSystem(`Router → ${arg}`);
        break;
      case "auto-decider":
        if (!arg) {
          this.pushSystem("Usage: /auto-decider <participant-id>");
          break;
        }
        this.session.setAutoDecider(arg);
        this.pushSystem(`Auto-decider → ${arg}`);
        break;
      case "thinking":
        if (arg !== "low" && arg !== "medium" && arg !== "high") {
          this.pushSystem("Usage: /thinking low|medium|high");
          break;
        }
        this.session.setThinking(arg);
        this.pushSystem(`Thinking → ${arg}`);
        break;
      case "expand":
        this.session.setCollapsePolicy("expanded");
        this.model.entries = this.model.entries.map((e) =>
          e.kind === "stage" || e.kind === "invocation" || e.kind === "tool"
            ? { ...e, collapsed: false }
            : e,
        );
        this.pushSystem("Streams expanded.");
        break;
      case "collapse":
        this.session.setCollapsePolicy("collapsed");
        this.model.entries = this.model.entries.map((e) =>
          e.kind === "stage" || e.kind === "invocation" || e.kind === "tool"
            ? { ...e, collapsed: true }
            : e,
        );
        this.pushSystem("Streams collapsed.");
        break;
      case "plan":
        this.session.togglePlanMode();
        this.pushSystem(`Plan mode ${this.session.snapshot.planMode ? "ON" : "OFF"}.`);
        break;
      case "tools":
        this.pushSystem(`Built-in tools: ${this.tools.listTools().join(", ")}`);
        break;
      case "tool": {
        const [name, ...toolArgs] = rest;
        if (!name) {
          this.pushSystem("Usage: /tool <name> [json-args]");
          break;
        }
        let args: Record<string, unknown> = {};
        if (toolArgs.length) {
          try {
            args = JSON.parse(toolArgs.join(" ")) as Record<string, unknown>;
          } catch {
            args = { path: toolArgs.join(" "), pattern: toolArgs.join(" ") };
          }
        }
        const result = await this.tools.invoke(name, args);
        this.pushEntry({
          kind: "tool",
          title: `tool ${name}`,
          body: result.ok
            ? `${result.summary}\n${result.content ?? ""}`
            : `${result.summary}: ${result.error ?? "failed"}`,
          collapsed: this.session.snapshot.collapsePolicy === "collapsed",
        });
        break;
      }
      case "status": {
        const doctor = await this.runtime.registry.doctor({ cwd: this.cwd });
        const lines = Object.entries(doctor)
          .map(([id, health]) => `${id}: ${health.status} — ${health.message}`)
          .join("\n");
        this.pushSystem(lines || "No connectors.");
        break;
      }
      case "usage": {
        const parts = [
          `calls=${this.model.usage.calls}`,
          this.model.usage.reported
            ? `tokens in=${this.model.usage.inputTokens} out=${this.model.usage.outputTokens}`
            : "tokens=unavailable (subscription CLIs often omit usage)",
          ...Object.entries(this.model.usage.byParticipant).map(
            ([id, u]) => `${id}: ${u.calls} calls, ${u.input}↓ ${u.output}↑`,
          ),
        ];
        this.pushSystem(parts.join("\n"));
        break;
      }
      default:
        this.pushSystem(`Unknown command /${cmd}. Try /help.`);
    }
    this.paint();
  }

  private onProgress(progress: RunProgress): void {
    this.model.lastProgress = progress;
    const live: typeof this.model.live = {
      phase: progress.phase,
      lastMessage: progress.message,
    };
    const invoker = progress.displayName ?? progress.participantId;
    if (invoker) live.invoking = invoker;
    if (progress.stageId) live.stageId = progress.stageId;
    this.model.live = live;

    if (progress.phase === "invocation" && progress.participantId) {
      this.pushEntry({
        kind: "invocation",
        title: `invoke ${progress.displayName ?? progress.participantId}`,
        body: progress.message,
        collapsed: this.session.snapshot.collapsePolicy === "collapsed",
        ...(progress.stageId ? { stageId: progress.stageId } : {}),
        participantId: progress.participantId,
      });
      this.bumpUsage(progress.participantId, undefined, true);
    } else if (progress.phase === "invocation_complete") {
      this.bumpUsage(progress.participantId, progress.usage, false);
      if (progress.preview) {
        for (let i = this.model.entries.length - 1; i >= 0; i -= 1) {
          const entry = this.model.entries[i];
          if (
            entry?.kind === "invocation" &&
            entry.participantId === progress.participantId &&
            entry.stageId === progress.stageId
          ) {
            this.model.entries[i] = {
              ...entry,
              body: progress.preview,
              title: `done ${progress.displayName ?? progress.participantId}`,
            };
            break;
          }
        }
      }
    } else if (progress.stageId && progress.phase !== "completed") {
      const exists = this.model.entries.some(
        (e) => e.kind === "stage" && e.stageId === progress.stageId,
      );
      if (!exists) {
        this.pushEntry({
          kind: "stage",
          title: `stage ${progress.stageId} · ${progress.operator ?? progress.phase}`,
          body: progress.message,
          collapsed: this.session.snapshot.collapsePolicy === "collapsed",
          stageId: progress.stageId,
        });
      }
    }
    this.model.statusLine = progress.message;
    this.paint();
  }

  private bumpUsage(
    participantId: string | undefined,
    usage: RunProgress["usage"] | undefined,
    countCall: boolean,
  ): void {
    const next: UsageTotals = {
      ...this.model.usage,
      byParticipant: { ...this.model.usage.byParticipant },
    };
    if (countCall) next.calls += 1;
    if (usage?.source === "reported" || usage?.source === "estimated") {
      next.reported = true;
      if (typeof usage.inputTokens === "number") next.inputTokens += usage.inputTokens;
      if (typeof usage.outputTokens === "number") next.outputTokens += usage.outputTokens;
    }
    if (participantId) {
      const prev = next.byParticipant[participantId] ?? { input: 0, output: 0, calls: 0 };
      next.byParticipant[participantId] = {
        input: prev.input + (usage?.inputTokens ?? 0),
        output: prev.output + (usage?.outputTokens ?? 0),
        calls: prev.calls + (countCall ? 1 : 0),
      };
    }
    this.model.usage = next;
  }

  private async runQuery(query: string): Promise<void> {
    if (this.busy) {
      this.pushSystem("A run is already in progress.");
      this.paint();
      return;
    }
    this.busy = true;
    this.model.running = true;
    this.abort = new AbortController();
    this.pushEntry({ kind: "user", title: "you", body: query, collapsed: false });
    this.paint();

    try {
      // Auto config source: LLM picks council parameters first
      if (
        this.session.snapshot.configSource === "auto" &&
        this.session.snapshot.mode !== "routed"
      ) {
        this.pushSystem("Auto-decider selecting approach / roles / hyperparameters…");
        this.paint();
        const decider = new AutoDecider(this.runtime.loadedConfig.config, this.runtime.registry);
        const eligible =
          this.session.snapshot.participants ??
          this.runtime.loadedConfig.config.profiles[this.session.snapshot.profileId]
            ?.participants ??
          [];
        const decision = await decider.decide({
          query,
          goal: this.session.snapshot.goal,
          eligibleParticipants: eligible,
          deciderParticipantId:
            this.session.snapshot.autoDeciderParticipantId ??
            this.session.snapshot.synthesizer ??
            "codex-architect",
          cwd: this.cwd,
          signal: this.abort.signal,
        });
        this.session.applyAutoDecision(decision);
        this.pushSystem(
          `Auto → ${decision.protocolId} · ${decision.participants.join(", ")} · rounds=${decision.critiqueRounds}${
            decision.source === "default-fallback"
              ? ` (fallback: ${decision.fallbackReason ?? "default"})`
              : ""
          }\n${decision.rationale}`,
        );
        this.paint();
      }

      const snap = this.session.snapshot;
      if (snap.mode === "routed") {
        const orchestrator = new RoutedRunOrchestrator(
          this.runtime.router,
          this.runtime.runs,
          this.runtime.repository,
        );
        const result = await orchestrator.run(
          {
            query: snap.goal.trim() ? `${snap.goal.trim()}\n\n${query}` : query,
            profileId: snap.profileId || "router-balanced",
            cwd: this.cwd,
            ...(snap.routerParticipantId ? { routerParticipantId: snap.routerParticipantId } : {}),
            ...(snap.configSource === "manual" && snap.configSource ? {} : {}),
          },
          {
            cwd: this.cwd,
            thinking: snap.thinking,
            signal: this.abort.signal,
            onProgress: (p) => this.onProgress(p),
          },
        );
        this.finishResult(result.decision?.answer, result.run.status, result.route?.source);
      } else {
        const request = this.session.toRunRequest(query);
        const result = await this.runtime.runs.run(request, {
          cwd: this.cwd,
          thinking: snap.thinking,
          signal: this.abort.signal,
          onProgress: (p) => this.onProgress(p),
        });
        this.finishResult(result.decision?.answer, result.run.status);
      }
    } catch (error) {
      this.pushEntry({
        kind: "error",
        title: "error",
        body: error instanceof Error ? error.message : String(error),
        collapsed: false,
      });
      this.model.statusLine = "Run failed";
    } finally {
      this.busy = false;
      this.model.running = false;
      this.model.live = {};
      this.abort = undefined;
      this.paint();
    }
  }

  private finishResult(answer: string | undefined, status: string, routeSource?: string): void {
    const body =
      answer ??
      (status === "paused"
        ? "Run paused (human gate or recovery). Use batch CLI to resume if needed."
        : `Run ${status}.`);
    this.pushEntry({
      kind: "decision",
      title: routeSource ? `decision · route ${routeSource}` : "decision",
      body,
      collapsed: false,
    });
    this.model.statusLine = `Run ${status}`;
  }
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const onData = (buf: Buffer): void => {
      if (buf.includes(0x0d) || buf.includes(0x0a)) {
        input.off("data", onData);
        resolve();
      }
    };
    input.on("data", onData);
  });
}
