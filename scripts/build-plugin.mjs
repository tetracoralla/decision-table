import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { writeThirdPartyNotices } from "./generate-third-party-notices.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const pluginRoot = new URL("../plugins/decision-table/", import.meta.url);
await mkdir(new URL("server/", pluginRoot), { recursive: true });

const result = await build({
  bundle: true,
  entryPoints: [fileURLToPath(new URL("../src/mcp.ts", import.meta.url))],
  format: "esm",
  legalComments: "external",
  metafile: true,
  outfile: fileURLToPath(new URL("server/index.mjs", pluginRoot)),
  platform: "node",
  target: "node20",
});

await writeThirdPartyNotices({
  repositoryRoot,
  bundledInputs: Object.keys(result.metafile.inputs),
  outputPaths: [
    fileURLToPath(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url)),
    fileURLToPath(new URL("../plugins/decision-table/THIRD_PARTY_NOTICES.md", import.meta.url)),
  ],
  productName: "Decision Table",
});

await Promise.all([
  copyFile(new URL("../LICENSE", import.meta.url), new URL("LICENSE", pluginRoot)),
  copyFile(new URL("../NOTICE", import.meta.url), new URL("NOTICE", pluginRoot)),
]);
