import { spawn, type ChildProcess } from "node:child_process";
import { SwitchError } from "../domain/errors.js";

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly durationMs: number;
}

export interface ProcessRunOptions {
  readonly cwd: string;
  readonly input?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly environmentAllowlist: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly injectedEnvironment?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
  readonly terminationGraceMs?: number;
  readonly onStderr?: (chunk: string) => void;
}

export interface InteractiveProcessOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly environment?: NodeJS.ProcessEnv;
}

function allowedEnvironment(
  allowlist: readonly string[],
  source: NodeJS.ProcessEnv,
  injected: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowlist) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(injected)) environment[name] = value;
  return environment;
}

function terminateProcessTree(child: ChildProcess, force = false): void {
  const signal = force ? "SIGKILL" : "SIGTERM";
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited.
    }
  }
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: ProcessRunOptions,
): Promise<ProcessResult> {
  const {
    cwd,
    input,
    timeoutMs,
    signal,
    environmentAllowlist,
    environment = process.env,
    injectedEnvironment = {},
    maxOutputBytes = 10 * 1024 * 1024,
    terminationGraceMs = 2_000,
    onStderr,
  } = options;

  if (signal?.aborted) {
    return Promise.reject(
      new SwitchError({
        code: "cancelled",
        message: `${command} invocation was cancelled before launch.`,
        retry: "non_retryable",
      }),
    );
  }

  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(command, [...args], {
      cwd,
      env: allowedEnvironment(environmentAllowlist, environment, injectedEnvironment),
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const cleanup = (clearForceTimer = true): void => {
      clearTimeout(timeout);
      if (clearForceTimer && forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener("abort", abort);
    };

    const finish = (callback: (value: ProcessResult) => void, value: ProcessResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const fail = (error: SwitchError, terminate = false): void => {
      if (settled) return;
      if (terminate) {
        terminateProcessTree(child);
        forceTimer = setTimeout(() => terminateProcessTree(child, true), terminationGraceMs);
        forceTimer.unref();
      }
      settled = true;
      cleanup(!terminate);
      reject(error);
    };

    const abort = (): void => {
      fail(
        new SwitchError({
          code: "cancelled",
          message: `${command} invocation was cancelled.`,
          retry: "non_retryable",
          details: { command },
        }),
        true,
      );
    };

    const timeout = setTimeout(() => {
      fail(
        new SwitchError({
          code: "timeout",
          message: `${command} timed out after ${timeoutMs}ms.`,
          retry: "unknown",
          details: { command, timeoutMs, stdout, stderr },
        }),
        true,
      );
    }, timeoutMs);

    const appendOutput = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > maxOutputBytes) {
        fail(
          new SwitchError({
            code: "provider_error",
            message: `${command} exceeded the ${maxOutputBytes}-byte output limit.`,
            retry: "non_retryable",
            details: { command, maxOutputBytes },
          }),
          true,
        );
        return;
      }
      if (target === "stdout") stdout += text;
      else {
        stderr += text;
        onStderr?.(text);
      }
    };

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: string) => appendOutput("stderr", chunk));
    child.on("error", (error) => {
      fail(
        new SwitchError({
          code: error.message.includes("ENOENT") ? "connector_unavailable" : "provider_error",
          message: `Failed to launch ${command}: ${error.message}`,
          retry: "non_retryable",
          cause: error,
          details: { command },
        }),
      );
    });
    child.on("close", (code, childSignal) => {
      if (forceTimer) clearTimeout(forceTimer);
      if (settled) return;
      const result = {
        stdout,
        stderr,
        code: code ?? -1,
        durationMs: performance.now() - startedAt,
      };
      if (code === 0) {
        finish(resolve, result);
      } else {
        fail(
          new SwitchError({
            code: "provider_error",
            message: `${command} exited with code ${code ?? "unknown"}.`,
            retry: "unknown",
            details: { command, code, signal: childSignal, stdout, stderr },
          }),
        );
      }
    });
    child.stdin?.on("error", () => {
      // A CLI may close stdin before consuming all input.
    });
    child.stdin?.end(input);
  });
}

/** Run an interactive authentication flow with the user's real terminal attached. */
export function runInteractiveProcess(
  command: string,
  args: readonly string[],
  options: InteractiveProcessOptions,
): Promise<number> {
  if (options.signal?.aborted)
    return Promise.reject(
      options.signal.reason instanceof Error ? options.signal.reason : new Error("cancelled"),
    );
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.environment ?? process.env,
      shell: false,
      stdio: "inherit",
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let settled = false;
    const terminate = (): void => {
      try {
        if (child.pid !== undefined && process.platform !== "win32")
          process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    };
    const timeout = setTimeout(() => {
      terminate();
      if (!settled) {
        settled = true;
        reject(
          new SwitchError({
            code: "timeout",
            message: `${command} login timed out after ${options.timeoutMs}ms.`,
            retry: "unknown",
          }),
        );
      }
    }, options.timeoutMs);
    const abort = (): void => {
      terminate();
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(
          new SwitchError({
            code: "cancelled",
            message: `${command} login was cancelled.`,
            retry: "non_retryable",
          }),
        );
      }
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      resolve(code ?? -1);
    });
  });
}
