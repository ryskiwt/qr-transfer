import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const siteDir = process.argv[2] || "_site";
const sbomPath = process.argv[3] || "qr-transfer-site.spdx.json";
const checksumsPath = process.argv[4] || "site.sha256";

const vendorPackages = [
  {
    name: "peerjs",
    spdxId: "SPDXRef-Package-peerjs",
    version: "1.5.5",
    downloadLocation: "https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js",
    purl: "pkg:npm/peerjs@1.5.5",
  },
  {
    name: "qrcodejs",
    spdxId: "SPDXRef-Package-qrcodejs",
    version: "1.0.0",
    downloadLocation: "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js",
  },
];

const toPosix = (value) => value.split(sep).join("/");

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    if (entry.isFile()) return [path];
    return [];
  }));
  return files.flat().sort((a, b) => a.localeCompare(b));
}

function createSpdxId(path) {
  return `SPDXRef-File-${path.replace(/[^A-Za-z0-9.]/g, "-")}`;
}

function createFileEntry(path, checksums) {
  const fileName = `./${toPosix(relative(siteDir, path))}`;
  return {
    fileName,
    SPDXID: createSpdxId(fileName),
    checksums: [
      { algorithm: "SHA1", checksumValue: checksums.sha1 },
      { algorithm: "SHA256", checksumValue: checksums.sha256 },
    ],
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION",
  };
}

const files = await listFiles(siteDir);
const fileEntries = [];
const checksumLines = [];

for (const path of files) {
  const content = await readFile(path);
  const checksums = {
    sha1: createHash("sha1").update(content).digest("hex"),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  fileEntries.push(createFileEntry(path, checksums));
  checksumLines.push(`${checksums.sha256}  ${toPosix(path)}`);
}

const packageVerificationCode = createHash("sha1")
  .update(fileEntries.map((file) => file.checksums[0].checksumValue).sort().join(""))
  .digest("hex");

const created = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const repository = process.env.GITHUB_REPOSITORY || "local/qr-transfer";
const revision = process.env.GITHUB_SHA || "local";
const runId = process.env.GITHUB_RUN_ID || "local";

const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "qr-transfer-site",
  documentNamespace: `https://github.com/${repository}/sbom/${revision}/${runId}`,
  creationInfo: {
    created,
    creators: ["Tool: qr-transfer generate-release-metadata"],
  },
  packages: [
    {
      name: "qr-transfer-site",
      SPDXID: "SPDXRef-Package-qr-transfer-site",
      downloadLocation: "NOASSERTION",
      filesAnalyzed: true,
      packageVerificationCode: {
        packageVerificationCodeValue: packageVerificationCode,
      },
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
    },
    ...vendorPackages.map((dependency) => ({
      name: dependency.name,
      SPDXID: dependency.spdxId,
      versionInfo: dependency.version,
      downloadLocation: dependency.downloadLocation,
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: "NOASSERTION",
      copyrightText: "NOASSERTION",
      ...(dependency.purl
        ? {
            externalRefs: [
              {
                referenceCategory: "PACKAGE-MANAGER",
                referenceType: "purl",
                referenceLocator: dependency.purl,
              },
            ],
          }
        : {}),
    })),
  ],
  files: fileEntries,
  relationships: [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-Package-qr-transfer-site",
    },
    ...fileEntries.map((file) => ({
      spdxElementId: "SPDXRef-Package-qr-transfer-site",
      relationshipType: "CONTAINS",
      relatedSpdxElement: file.SPDXID,
    })),
    ...vendorPackages.map((dependency) => ({
      spdxElementId: "SPDXRef-Package-qr-transfer-site",
      relationshipType: "DEPENDS_ON",
      relatedSpdxElement: dependency.spdxId,
    })),
  ],
};

await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
await writeFile(checksumsPath, `${checksumLines.join("\n")}\n`);
