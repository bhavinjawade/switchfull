import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionController } from "../src/application/session-controller.js";
import { defaultConfig } from "../src/config/defaults.js";
import { parametersForProtocol, defaultHyperparams } from "../src/protocol/parameters.js";
import { resolveRoleBindings, roleSlotsForProtocol } from "../src/protocol/roles.js";
import { ToolHost } from "../src/tools/host.js";

void describe("session controller", () => {
  void it("starts from default profile settings", () => {
    const session = new SessionController({ config: defaultConfig });
    const snap = session.snapshot;
    assert.equal(snap.configSource, "default");
    assert.equal(snap.mode, "council");
    assert.ok(snap.protocolId);
    assert.ok((snap.participants?.length ?? 0) > 0);
  });

  void it("switches modes and builds run requests", () => {
    const session = new SessionController({ config: defaultConfig });
    session.setMode("routed");
    assert.equal(session.snapshot.mode, "routed");
    session.setMode("council");
    session.setConfigSource("manual");
    session.setProtocol("tournament");
    session.setCritiqueRounds(2);
    session.setGoal("Ship auth safely");
    const request = session.toRunRequest("design the middleware");
    assert.match(request.query, /Ship auth safely/);
    assert.equal(request.protocolId, "tournament");
    assert.equal(request.critiqueRounds, 2);
  });

  void it("applies auto decisions", () => {
    const session = new SessionController({ config: defaultConfig });
    session.applyAutoDecision({
      protocolId: "jury",
      participants: ["codex-architect", "grok-challenger"],
      synthesizer: "codex-architect",
      critiqueRounds: 1,
    });
    assert.equal(session.snapshot.configSource, "auto");
    assert.equal(session.snapshot.protocolId, "jury");
  });
});

void describe("protocol parameters and roles", () => {
  void it("exposes parameter specs", () => {
    assert.ok(parametersForProtocol("self-consistency").some((p) => p.key === "sampleCount"));
    assert.deepEqual(defaultHyperparams("direct"), {});
  });

  void it("resolves role bindings", () => {
    const slots = roleSlotsForProtocol("generator-critic-verifier");
    assert.ok(slots.some((s) => s.id === "generator"));
    const resolved = resolveRoleBindings(
      "independent-critique-synthesis",
      { members: "a,b,c", synthesizer: "a" },
      ["x"],
      "x",
    );
    assert.deepEqual(resolved.participants, ["a", "b", "c"]);
    assert.equal(resolved.synthesizer, "a");
  });
});

void describe("approach papers", () => {
  void it("links independent council and other approaches to papers", async () => {
    const { approachPaper, listApproachPapers } = await import("../src/protocol/papers.js");
    const independent = approachPaper("independent-critique-synthesis");
    assert.ok(independent?.url.includes("arxiv.org"));
    assert.match(independent?.title ?? "", /ChatEval|arxiv/i);
    const all = listApproachPapers();
    assert.ok(all.length >= 10);
    assert.ok(all.every((p) => p.url.startsWith("http")));
  });
});

void describe("tool host", () => {
  void it("lists and reads workspace files", async () => {
    const host = new ToolHost({ workspaceRoot: process.cwd() });
    assert.ok(host.listTools().includes("read_file"));
    const tree = await host.invoke("list_dir", { path: "src" });
    assert.equal(tree.ok, true);
    assert.match(tree.content ?? "", /tui|cli/);
  });

  void it("blocks path escape", async () => {
    const host = new ToolHost({ workspaceRoot: process.cwd() });
    const result = await host.invoke("read_file", { path: "../../etc/passwd" });
    assert.equal(result.ok, false);
  });
});
