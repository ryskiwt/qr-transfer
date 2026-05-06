import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const outputDir = process.argv[2] || "_site";
const siteEntries = [
  "index.html",
  "styles.css",
  "app.js",
  "src",
  "vendor/peerjs.min.js",
  "vendor/qrcode.min.js",
];

await rm(outputDir, { force: true, recursive: true });

for (const entry of siteEntries) {
  const destination = join(outputDir, entry);
  await mkdir(dirname(destination), { recursive: true });
  await cp(entry, destination, { recursive: true });
}
