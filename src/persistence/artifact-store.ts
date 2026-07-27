import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sha256 } from "../domain/hash.js";

export interface StoredContent {
  readonly hash: string;
  readonly path: string;
  readonly byteSize: number;
}

export class FileArtifactStore {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  put(content: string | Uint8Array): StoredContent {
    const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
    const hash = sha256(bytes);
    const directory = join(this.root, hash.slice(0, 2));
    const path = join(directory, hash);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      try {
        renameSync(temporary, path);
      } catch (error) {
        if (!existsSync(path)) throw error;
        unlinkSync(temporary);
      }
    }
    return { hash, path, byteSize: bytes.byteLength };
  }

  get(path: string, expectedHash?: string): Buffer {
    const content = readFileSync(path);
    if (expectedHash && sha256(content) !== expectedHash) {
      throw new Error(`Artifact integrity check failed for ${path}`);
    }
    return content;
  }
}
