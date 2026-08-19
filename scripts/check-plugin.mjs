import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = process.cwd();
const pluginRoot = resolve(root, "plugins/decision-table");
const manifestPath = resolve(pluginRoot, ".codex-plugin/plugin.json");
const mcpPath = resolve(pluginRoot, ".mcp.json");
const skillRoot = resolve(pluginRoot, "skills/use-decision-table");
const skillPath = resolve(skillRoot, "SKILL.md");
const skillMetadataPath = resolve(skillRoot, "agents/openai.yaml");
const failures = [];

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${label} is missing or invalid JSON: ${error instanceof Error ? error.message : error}`);
    return {};
  }
}

const manifest = readJson(manifestPath, "plugin manifest");
const mcp = readJson(mcpPath, "plugin MCP configuration");
const marketplace = readJson(resolve(root, ".agents/plugins/marketplace.json"), "repository marketplace manifest");
const marketplaceEntry = marketplace.plugins?.find((plugin) => plugin.name === manifest.name);
if (!marketplaceEntry) failures.push("marketplace manifest does not list the plugin");
if (marketplace.name !== manifest.name) failures.push("marketplace and plugin names differ");
if (marketplace.interface?.displayName !== manifest.interface?.displayName) {
  failures.push("marketplace and plugin display names differ");
}
if (marketplaceEntry?.source?.path !== "./plugins/decision-table") {
  failures.push("marketplace manifest plugin path must be ./plugins/decision-table");
}
if (marketplaceEntry?.source?.source !== "local") {
  failures.push("marketplace manifest plugin source must be local to the cloned repository");
}
if (marketplaceEntry?.policy?.installation !== "AVAILABLE") {
  failures.push("marketplace plugin must be available for explicit installation");
}
if (marketplaceEntry?.policy?.authentication !== "ON_INSTALL") {
  failures.push("marketplace plugin authentication policy must be ON_INSTALL");
}
if (marketplaceEntry?.category !== manifest.interface?.category) {
  failures.push("marketplace and plugin categories differ");
}
if (manifest.name !== basename(pluginRoot)) failures.push("plugin folder and manifest name differ");
for (const field of ["version", "description", "license", "skills", "mcpServers"]) {
  if (!manifest[field]) failures.push(`plugin manifest is missing ${field}`);
}
if (manifest.skills !== "./skills/") failures.push("plugin skill path must be ./skills/");
if (manifest.mcpServers !== "./.mcp.json") failures.push("plugin MCP path must be ./.mcp.json");
const server = mcp.mcpServers?.decision_table;
if (!server || server.command !== "node" || server.cwd !== ".") {
  failures.push("decision_table MCP server must use node from the plugin root");
}
const serverEntry = server?.args?.[0];
if (!serverEntry || !existsSync(resolve(pluginRoot, serverEntry))) {
  failures.push("built plugin MCP entry is missing");
}

let skill = "";
try {
  skill = readFileSync(skillPath, "utf8");
} catch (error) {
  failures.push(`plugin Skill is missing: ${error instanceof Error ? error.message : error}`);
}
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? "";
const frontmatterKeys = [...frontmatter.matchAll(/^([A-Za-z0-9_-]+):/gm)].map((match) => match[1]);
if (frontmatterKeys.join(",") !== "name,description") {
  failures.push("Skill frontmatter must contain only name and description");
}
if (!/^name: use-decision-table$/m.test(frontmatter)) failures.push("Skill name is invalid");
if (!/^description: .+/m.test(frontmatter)) failures.push("Skill description is missing");
if (skill.includes("[TODO:")) failures.push("Skill contains TODO placeholders");

let metadata = "";
try {
  metadata = readFileSync(skillMetadataPath, "utf8");
} catch (error) {
  failures.push(`Skill UI metadata is missing: ${error instanceof Error ? error.message : error}`);
}
for (const field of ["display_name", "short_description", "default_prompt"]) {
  if (!new RegExp(`^  ${field}: ".+"$`, "m").test(metadata)) {
    failures.push(`Skill UI metadata is missing quoted ${field}`);
  }
}
if (!metadata.includes("$use-decision-table")) {
  failures.push("Skill default prompt must mention $use-decision-table");
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`plugin check failure: ${failure}\n`);
  process.exit(1);
}
process.stdout.write("portable plugin and Skill checks passed\n");
