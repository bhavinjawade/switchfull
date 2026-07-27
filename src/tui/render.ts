import { SWITCH_VERSION } from "../domain/version.js";
import { ansi, color, pad, truncate, wrap } from "./ansi.js";
import type { TuiModel } from "./types.js";

function line(width: number, char = "─"): string {
  return char.repeat(Math.max(0, width));
}

function boxTitle(title: string, width: number): string {
  const plain = ` ${title} `;
  if (plain.length + 2 >= width) return truncate(plain, width);
  return `─${plain}${line(width - plain.length - 1)}`;
}

function applySurface(frame: string): string {
  if (process.env["NO_COLOR"]) return frame;
  return frame
    .split("\n")
    .map((line) => {
      const restored = line.replaceAll(ansi.reset, `${ansi.reset}${ansi.bgPanel}`);
      return `${ansi.bgPanel}${restored}${ansi.reset}`;
    })
    .join("\n");
}

function background(text: string, surface: string): string {
  return `${surface}${text.replaceAll(ansi.reset, `${ansi.reset}${surface}`)}${ansi.reset}`;
}

export function renderFrame(model: TuiModel): string {
  const { width, height } = model;
  if (width < 40 || height < 12) {
    return color("Terminal too small. Resize to at least 40x12.", ansi.red);
  }

  const frame =
    model.screen === "splash"
      ? renderSplash(model)
      : model.screen === "setup"
        ? renderSetup(model)
        : model.screen === "help"
          ? renderHelp(model)
          : model.screen === "protocols"
            ? renderProtocols(model)
            : model.screen === "council"
              ? renderCouncil(model)
              : renderMain(model);
  return applySurface(frame);
}

function renderSplash(model: TuiModel): string {
  const { width, height } = model;
  const logo = [
    color(
      "  ███████╗██╗    ██╗██╗████████╗ ██████╗██╗  ██╗███████╗██╗   ██╗██╗     ██╗     ",
      ansi.cyan,
      ansi.bold,
    ),
    color(
      "  ██╔════╝██║    ██║██║╚══██╔══╝██╔════╝██║  ██║██╔════╝██║   ██║██║     ██║     ",
      ansi.cyan,
    ),
    color(
      "  ███████╗██║ █╗ ██║██║   ██║   ██║     ███████║█████╗  ██║   ██║██║     ██║     ",
      ansi.magenta,
    ),
    color(
      "  ╚════██║██║███╗██║██║   ██║   ██║     ██╔══██║██╔══╝  ██║   ██║██║     ██║     ",
      ansi.magenta,
    ),
    color(
      "  ███████║╚███╔███╔╝██║   ██║   ╚██████╗██║  ██║██║     ╚██████╔╝███████╗███████╗",
      ansi.blue,
    ),
    color(
      "  ╚══════╝ ╚══╝╚══╝ ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝╚═╝      ╚═════╝ ╚══════╝╚══════╝",
      ansi.blue,
    ),
  ];
  const lines: string[] = [];
  const topPad = Math.max(1, Math.floor((height - 18) / 2));
  for (let i = 0; i < topPad; i += 1) lines.push("");
  for (const row of logo) lines.push(pad(row, width));
  lines.push("");
  lines.push(
    pad(
      color(`  LLM councils · dynamic routing · test-time compute  v${SWITCH_VERSION}`, ansi.dim),
      width,
    ),
  );
  lines.push(pad(color(`  workspace  ${model.cwd}`, ansi.gray), width));
  lines.push("");
  lines.push(
    pad(
      color("  Press Enter to start  ·  s setup  ·  ? help  ·  q quit", ansi.bold, ansi.cyan),
      width,
    ),
  );
  lines.push("");
  lines.push(
    pad(
      color(
        "  Slash commands once inside: /mode /council /config /goal /plan /setup /tools",
        ansi.dim,
      ),
      width,
    ),
  );
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}

function renderMain(model: TuiModel): string {
  const { width, height } = model;
  const railWidth = Math.min(36, Math.max(28, Math.floor(width * 0.32)));
  const mainWidth = width - railWidth - 1;
  const headerH = 2;
  const footerH = 3;
  const bodyH = height - headerH - footerH;

  const header = [
    background(
      pad(
        color(" SWITCH ", ansi.bold, ansi.bgCyan, ansi.white) +
          color(
            ` ${model.session.mode.toUpperCase()} · ${model.session.configSource} · ${model.session.profileId} `,
            ansi.white,
          ) +
          color(model.running ? " ● running" : " ○ idle", model.running ? ansi.yellow : ansi.gray),
        width,
      ),
      ansi.bgHeader,
    ),
    background(color(line(width), ansi.gray), ansi.bgHeader),
  ];

  const mainLines = renderMainPane(model, mainWidth, bodyH);
  const railLines = renderRail(model, railWidth, bodyH);
  const body: string[] = [];
  for (let i = 0; i < bodyH; i += 1) {
    body.push(
      `${pad(mainLines[i] ?? "", mainWidth)}${color("│", ansi.dim)}${pad(railLines[i] ?? "", railWidth)}`,
    );
  }

  const footer = [
    background(color(line(width), ansi.gray), ansi.bgPanelAlt),
    pad(
      color("> ", ansi.green, ansi.bold) +
        (model.input || color("ask the council, or type /help …", ansi.dim)) +
        (model.running ? "" : color("█", ansi.green)),
      width,
    ),
    pad(
      color(
        model.statusLine ||
          "enter send · /paper open approach paper · tab expand · /help · ctrl+c quit",
        ansi.gray,
      ),
      width,
    ),
  ];

  return [...header, ...body, ...footer].join("\n");
}

function renderMainPane(model: TuiModel, width: number, height: number): string[] {
  const lines: string[] = [];
  lines.push(color(boxTitle("session", width), ansi.dim));

  if (model.entries.length === 0) {
    lines.push(color("  Welcome. Ask a question or open /setup to connect providers.", ansi.dim));
    lines.push(color("  Modes: council (fixed roster) · routed (auto router per query)", ansi.dim));
    lines.push(color("  Config: default presets · manual controls · auto (LLM decides)", ansi.dim));
  }

  const renderedEntries: string[] = [];
  for (const entry of model.entries) {
    const railColor =
      entry.kind === "user"
        ? ansi.blue
        : entry.kind === "error"
          ? ansi.red
          : entry.kind === "decision"
            ? ansi.yellow
            : ansi.cyan;
    const icon =
      entry.kind === "user"
        ? color("❯", ansi.green)
        : entry.kind === "decision"
          ? color("★", ansi.yellow)
          : entry.kind === "error"
            ? color("✗", ansi.red)
            : entry.kind === "tool"
              ? color("⚙", ansi.blue)
              : color("▸", ansi.cyan);
    const collapseMark =
      entry.kind === "stage" || entry.kind === "invocation" || entry.kind === "tool"
        ? entry.collapsed
          ? color(" [collapsed]", ansi.dim)
          : color(" [expanded]", ansi.dim)
        : "";
    renderedEntries.push(
      `${color("┃", railColor)} ${icon} ${color(entry.title, ansi.bold, ansi.white)}${collapseMark}`,
    );
    if (!entry.collapsed && entry.body) {
      for (const wrapped of wrap(entry.body, Math.max(8, width - 4))) {
        renderedEntries.push(color("┃", railColor) + color(`   ${wrapped}`, ansi.white));
      }
    } else if (entry.collapsed && entry.body) {
      const preview = entry.body.replace(/\s+/g, " ").slice(0, Math.max(12, width - 8));
      renderedEntries.push(
        color("┃", railColor) +
          color(`   ${preview}${entry.body.length > preview.length ? "…" : ""}`, ansi.gray),
      );
    }
    renderedEntries.push("");
  }

  const start = Math.max(0, renderedEntries.length - (height - 1) + model.scroll);
  const slice = renderedEntries.slice(start, start + height - 1);
  lines.push(...slice);
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

function renderRail(model: TuiModel, width: number, height: number): string[] {
  const s = model.session;
  const lines: string[] = [];
  const push = (text: string, ...codes: string[]): void => {
    lines.push(pad(codes.length ? color(text, ...codes) : text, width));
  };

  push(boxTitle("session", width), ansi.dim);
  push(` Mode    ${s.mode}`);
  push(` Config  ${s.configSource}`);
  push(` Profile ${s.profileId}`);
  push(` Approach`, ansi.dim);
  const approachName = model.approach.name || model.approach.id || "—";
  push(`  ${truncate(approachName, width - 2)}`, ansi.cyan, ansi.bold);
  if (model.approach.id && model.approach.id !== approachName) {
    push(`  ${truncate(model.approach.id, width - 2)}`, ansi.dim);
  }
  if (model.approach.paperTitle) {
    push(`  📄 ${truncate(model.approach.paperTitle, width - 4)}`, ansi.magenta);
  }
  if (model.approach.paperUrl) {
    push(`  ${truncate(model.approach.paperUrl, width - 2)}`, ansi.blue, ansi.underline);
    push(`  /paper · open paper`, ansi.dim);
  } else {
    push(`  (no paper linked)`, ansi.dim);
  }
  push(` Rounds  ${s.critiqueRounds ?? "—"}`);
  push(` Think   ${s.thinking}`);
  push(` Plan    ${s.planMode ? "on" : "off"}`, s.planMode ? ansi.yellow : ansi.dim);
  lines.push(color(line(width), ansi.dim));

  push(boxTitle("roles · models", width), ansi.dim);
  const members = model.railMembers;
  if (members.length === 0) push("  (none)", ansi.dim);
  for (const member of members.slice(0, 6)) {
    const badges: string[] = [];
    if (member.isSynthesizer) badges.push("synth");
    if (member.isRouter) badges.push("router");
    const roleLine = badges.length ? `${member.role} [${badges.join(",")}]` : member.role;
    // Line 1: Role (+ synth/router)
    push(` ${truncate(roleLine, width - 2)}`, ansi.bold, ansi.white);
    // Line 2: concrete model id (e.g. gpt-5.6-sol, gemini-3.1-pro-high)
    push(`  ${truncate(member.model, width - 3)}`, ansi.green);
    // Line 3: connector path + display name
    push(`  ${truncate(`${member.connector} · ${member.displayName}`, width - 3)}`, ansi.dim);
  }
  if (s.autoDeciderParticipantId) {
    push(` auto-decider`, ansi.yellow);
    push(`  ${truncate(s.autoDeciderParticipantId, width - 3)}`, ansi.dim);
  }
  lines.push(color(line(width), ansi.dim));

  push(boxTitle("goal", width), ansi.dim);
  if (s.goal.trim()) {
    for (const w of wrap(s.goal, width - 2).slice(0, 4)) push(` ${w}`, ansi.green);
  } else {
    push("  /goal <text>", ansi.dim);
  }
  lines.push(color(line(width), ansi.dim));

  push(boxTitle("live", width), ansi.dim);
  if (model.live.invoking)
    push(` ▶ ${truncate(model.live.invoking, width - 3)}`, ansi.yellow, ansi.bold);
  else push("  idle", ansi.dim);
  if (model.live.stageId) push(` stage ${model.live.stageId}`, ansi.dim);
  if (model.live.phase) push(` phase ${model.live.phase}`, ansi.dim);
  lines.push(color(line(width), ansi.dim));

  push(boxTitle("usage", width), ansi.dim);
  push(` calls  ${model.usage.calls}`);
  push(
    ` tokens ${model.usage.reported ? `${model.usage.inputTokens}↓ ${model.usage.outputTokens}↑` : "unavailable"}`,
    model.usage.reported ? ansi.white : ansi.dim,
  );
  const top = Object.entries(model.usage.byParticipant).slice(0, 4);
  for (const [id, u] of top) {
    push(`  ${truncate(id, 12)} ${u.calls}c`, ansi.dim);
  }

  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

function renderSetup(model: TuiModel): string {
  const { width, height } = model;
  const lines: string[] = [
    pad(
      color(" SETUP", ansi.bold, ansi.white) +
        color("  install → authenticate → access", ansi.yellow),
      width,
    ),
    color(line(Math.min(width, 72)), ansi.dim),
    color(" Green means an access probe passed; installed alone is not usable.", ansi.gray),
    color(" Switch never scrapes credentials. Login is handed off to official CLIs.", ansi.gray),
    color(" Keys (OpenRouter) are referenced by env var name only.", ansi.gray),
    "",
  ];
  model.setupStatuses.forEach((item, index) => {
    const selected = index === model.setupIndex;
    const marker = selected ? color("┃", ansi.blue, ansi.bold) : color("│", ansi.dim);
    const statusColor =
      item.status === "available" || item.status === "healthy"
        ? ansi.green
        : item.status === "unauthenticated"
          ? ansi.yellow
          : ansi.red;
    const row = `${marker} ${color(pad(item.label, 22), ansi.bold, ansi.white)} ${color(item.status, statusColor, ansi.bold)}`;
    lines.push(pad(row, width));
    lines.push(
      pad(
        `${color("│", selected ? ansi.blue : ansi.dim)}   ${color(truncate(item.detail, width - 5), ansi.gray)}`,
        width,
      ),
    );
    lines.push("");
  });
  lines.push(color(line(Math.min(width, 72)), ansi.dim));
  lines.push(
    color(
      " ↑↓ select · Enter enable · l login handoff · d disable · r refresh · Esc back",
      ansi.blue,
    ),
  );
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}

function renderHelp(model: TuiModel): string {
  const { width, height } = model;
  const help = [
    "SLASH COMMANDS",
    "  /help                 this screen",
    "  /setup                provider setup wizard",
    "  /mode council|routed|direct|plan",
    "  /config manual|default|auto",
    "  /profile <id>         switch profile",
    "  /council              edit approach / roles",
    "  /protocols            list council approaches (+ papers)",
    "  /protocol <id>        set approach",
    "  /paper [id]           open approach paper in browser",
    "  /rounds <n>           critique/debate rounds",
    "  /goal <text>          session goal (right rail)",
    "  /router <participant> routed-mode router",
    "  /auto-decider <id>    LLM that picks auto config",
    "  /thinking low|medium|high",
    "  /expand  /collapse    stream density",
    "  /plan                 toggle plan mode",
    "  /tools                list built-in tools",
    "  /tool <name> [args]   run a built-in tool",
    "  /status               doctor summary",
    "  /usage                token / call usage",
    "  /clear                clear stream",
    "  /quit                 exit",
    "",
    "KEYS",
    "  Enter                 send query / confirm",
    "  Tab                   expand/collapse last stage",
    "  Esc                   back / clear input",
    "  Ctrl+C                quit",
  ];
  const lines = [
    background(pad(color(" HELP ", ansi.bold, ansi.bgBlue, ansi.white), width), ansi.bgHeader),
    background(color(line(width), ansi.gray), ansi.bgHeader),
    ...help.map((row) => color(row, ansi.white)),
    "",
    color(" Esc / q  back", ansi.cyan),
  ];
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}

function renderProtocols(model: TuiModel): string {
  const { width, height } = model;
  const lines = [
    pad(color(" APPROACHES", ansi.bold, ansi.white) + color("  protocols", ansi.yellow), width),
    color(line(Math.min(width, 72)), ansi.dim),
    color(" Each approach maps to a research paper / topology. o opens the paper.", ansi.gray),
    "",
  ];
  model.setupStatuses.forEach((item, index) => {
    const selected = index === model.protocolIndex;
    const row = `${selected ? color("┃", ansi.blue, ansi.bold) : color("│", ansi.dim)} ${color(item.label, ansi.bold, ansi.white)} ${color(item.status, ansi.gray)}`;
    lines.push(pad(row, width));
    lines.push(
      pad(
        `${color("│", selected ? ansi.blue : ansi.dim)}   ${color(truncate(item.detail, width - 5), ansi.gray)}`,
        width,
      ),
    );
    if (item.paperUrl) {
      lines.push(
        color(`│   📄 ${truncate(item.paperUrl, width - 5)}`, selected ? ansi.blue : ansi.dim),
      );
    }
    lines.push("");
  });
  lines.push("");
  lines.push(color(" ↑↓ · Enter select approach · o open paper · Esc back", ansi.cyan));
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}

function renderCouncil(model: TuiModel): string {
  const { width, height } = model;
  const s = model.session;
  const lines = [
    background(
      pad(color(" COUNCIL SETTINGS ", ansi.bold, ansi.bgMagenta, ansi.white), width),
      ansi.bgHeader,
    ),
    background(color(line(width), ansi.gray), ansi.bgHeader),
    ` Config source : ${s.configSource}`,
    ` Approach      : ${model.approach.name} (${model.approach.id || "—"})`,
    model.approach.paperTitle
      ? ` Paper         : ${model.approach.paperTitle}`
      : " Paper         : —",
    model.approach.paperUrl ? ` URL           : ${model.approach.paperUrl}` : "",
    ` Profile       : ${s.profileId}`,
    ` Rounds        : ${s.critiqueRounds ?? "—"}`,
    "",
    color(" Roster (role → model via connector)", ansi.bold),
    ...model.railMembers.flatMap((m) => [
      `  ${m.role}${m.isSynthesizer ? " [synth]" : ""}${m.isRouter ? " [router]" : ""}`,
      `    model: ${m.model}`,
      `    via:   ${m.connector} · ${m.displayName} (${m.id})`,
    ]),
    "",
    color(" Commands from main:", ansi.dim),
    color("  /config default|manual|auto", ansi.white),
    color("  /protocol <id>   /rounds <n>   /profile <id>", ansi.white),
    color("  /protocols       pick approach", ansi.white),
    color("  /paper           open current approach paper", ansi.white),
    "",
    color(" Esc back", ansi.cyan),
  ].filter((row) => row !== "");
  while (lines.length < height) lines.push("");
  return lines.slice(0, height).join("\n");
}
