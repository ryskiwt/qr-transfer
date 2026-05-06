import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const checksumsPath = process.argv[2] || "vendor/checksums.sha256";
const content = await readFile(checksumsPath, "utf8");
const entries = content
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

for (const entry of entries) {
  const match = entry.match(/^([a-f0-9]{64})\s+(.+)$/i);
  if (!match) {
    throw new Error(`Invalid checksum line: ${entry}`);
  }

  const [, expectedHash, path] = match;
  const file = await readFile(path);
  const actualHash = createHash("sha256").update(file).digest("hex");
  if (actualHash !== expectedHash.toLowerCase()) {
    throw new Error(`Vendor checksum mismatch: ${path}`);
  }
}

console.log(`Verified ${entries.length} vendored dependencies.`);
