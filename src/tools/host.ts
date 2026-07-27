import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export interface ToolResult {
  readonly ok: boolean;
  readonly name: string;
  readonly summary: string;
  readonly content?: string;
  readonly error?: string;
}

export interface ToolHostOptions {
  readonly workspaceRoot: string;
  readonly allowNetwork?: boolean;
  readonly maxFileBytes?: number;
  readonly maxEntries?: number;
}

function assertInsideRoot(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(resolvedRoot, target);
  const rel = relative(resolvedRoot, resolved);
  if (rel.startsWith(`..${sep}`) || rel === ".." || resolve(resolvedRoot, rel) !== resolved) {
    throw new Error(`Path escapes workspace: ${target}`);
  }
  return resolved;
}

function stringArg(args: Readonly<Record<string, unknown>>, key: string, fallback: string): string {
  return typeof args[key] === "string" ? args[key] : fallback;
}

export class ToolHost {
  private readonly maxFileBytes: number;
  private readonly maxEntries: number;

  constructor(private readonly options: ToolHostOptions) {
    this.maxFileBytes = options.maxFileBytes ?? 256_000;
    this.maxEntries = options.maxEntries ?? 200;
  }

  listTools(): readonly string[] {
    const tools = ["list_dir", "read_file", "search_code", "workspace_tree"];
    if (this.options.allowNetwork) tools.push("web_fetch");
    return tools;
  }

  async invoke(name: string, args: Readonly<Record<string, unknown>>): Promise<ToolResult> {
    try {
      switch (name) {
        case "list_dir":
          return this.listDir(stringArg(args, "path", "."));
        case "read_file":
          return this.readFile(stringArg(args, "path", ""));
        case "search_code":
          return this.searchCode(stringArg(args, "pattern", ""), stringArg(args, "path", "."));
        case "workspace_tree":
          return this.workspaceTree(stringArg(args, "path", "."), Number(args["depth"] ?? 2));
        case "web_fetch":
          if (!this.options.allowNetwork) {
            return {
              ok: false,
              name,
              summary: "Network tools disabled",
              error: "allowNetwork is false",
            };
          }
          return await this.webFetch(stringArg(args, "url", ""));
        default:
          return { ok: false, name, summary: "Unknown tool", error: `Unknown tool ${name}` };
      }
    } catch (error) {
      return {
        ok: false,
        name,
        summary: "Tool failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private listDir(path: string): ToolResult {
    const dir = assertInsideRoot(this.options.workspaceRoot, path || ".");
    const entries = readdirSync(dir, { withFileTypes: true })
      .slice(0, this.maxEntries)
      .map((entry) => `${entry.isDirectory() ? "dir" : "file"} ${entry.name}`);
    return {
      ok: true,
      name: "list_dir",
      summary: `${entries.length} entries in ${path || "."}`,
      content: entries.join("\n"),
    };
  }

  private readFile(path: string): ToolResult {
    if (!path) throw new Error("path is required");
    const file = assertInsideRoot(this.options.workspaceRoot, path);
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("Not a file");
    if (stat.size > this.maxFileBytes) {
      throw new Error(`File exceeds ${this.maxFileBytes} bytes`);
    }
    const text = readFileSync(file, "utf8");
    return {
      ok: true,
      name: "read_file",
      summary: `Read ${path} (${stat.size} bytes)`,
      content: text,
    };
  }

  private searchCode(pattern: string, path: string): ToolResult {
    if (!pattern) throw new Error("pattern is required");
    const root = assertInsideRoot(this.options.workspaceRoot, path || ".");
    const regex = new RegExp(pattern, "iu");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      if (hits.length >= this.maxEntries) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (hits.length >= this.maxEntries) break;
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") {
          continue;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        const ext = extname(entry.name).toLowerCase();
        if (
          ![".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".py", ".go", ".rs"].includes(ext)
        ) {
          continue;
        }
        try {
          const text = readFileSync(full, "utf8");
          const lines = text.split("\n");
          lines.forEach((line, index) => {
            if (hits.length >= this.maxEntries) return;
            if (regex.test(line)) {
              hits.push(
                `${relative(this.options.workspaceRoot, full)}:${index + 1}: ${line.trim()}`,
              );
            }
          });
        } catch {
          // skip unreadable
        }
      }
    };
    walk(root);
    return {
      ok: true,
      name: "search_code",
      summary: `${hits.length} hits for /${pattern}/`,
      content: hits.join("\n"),
    };
  }

  private workspaceTree(path: string, depth: number): ToolResult {
    const root = assertInsideRoot(this.options.workspaceRoot, path || ".");
    const lines: string[] = [];
    const walk = (dir: string, level: number, prefix: string): void => {
      if (level > depth || lines.length >= this.maxEntries) return;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true }).filter(
          (entry) =>
            entry.name !== "node_modules" && entry.name !== ".git" && entry.name !== "dist",
        );
      } catch {
        return;
      }
      entries.forEach((entry, index) => {
        if (lines.length >= this.maxEntries) return;
        const last = index === entries.length - 1;
        const branch = last ? "└── " : "├── ";
        lines.push(`${prefix}${branch}${entry.name}${entry.isDirectory() ? "/" : ""}`);
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), level + 1, `${prefix}${last ? "    " : "│   "}`);
        }
      });
    };
    lines.push(relative(this.options.workspaceRoot, root) || ".");
    walk(root, 1, "");
    return {
      ok: true,
      name: "workspace_tree",
      summary: `Tree depth ${depth}`,
      content: lines.join("\n"),
    };
  }

  private async webFetch(url: string): Promise<ToolResult> {
    if (!url.startsWith("https://") && !url.startsWith("http://")) {
      throw new Error("Only http(s) URLs are allowed");
    }
    const parsed = new URL(url);
    if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname)) {
      throw new Error("Private/local hosts are blocked");
    }
    const response = await fetch(url, {
      headers: { "user-agent": "switch-tools/0.1" },
      signal: AbortSignal.timeout(15_000),
    });
    const text = (await response.text()).slice(0, this.maxFileBytes);
    return {
      ok: response.ok,
      name: "web_fetch",
      summary: `HTTP ${response.status} ${url}`,
      content: text,
      ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
    };
  }
}
