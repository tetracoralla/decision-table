import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const failures = [];

function readText(path, label) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    failures.push(`${label} is missing`);
    return "";
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push(`${label} is missing or invalid JSON: ${error instanceof Error ? error.message : error}`);
    return {};
  }
}

const packageJson = readJson(resolve(root, "package.json"), "package manifest");
const pluginRoot = resolve(root, "plugins/decision-table");
const pluginJson = readJson(resolve(pluginRoot, ".codex-plugin/plugin.json"), "plugin manifest");
const mcpJson = readJson(resolve(pluginRoot, ".mcp.json"), "plugin MCP configuration");
const skill = readText(resolve(pluginRoot, "skills/use-decision-table/SKILL.md"), "product Skill");
const skillMetadata = readText(resolve(pluginRoot, "skills/use-decision-table/agents/openai.yaml"), "Skill UI metadata");
const identity = readText(resolve(root, "docs/PRODUCT_IDENTITY.md"), "product identity contract");
const readme = readText(resolve(root, "README.md"), "README");
const installation = readText(resolve(root, "docs/INSTALLATION.md"), "installation guide");
const license = readText(resolve(root, "LICENSE"), "license");
const security = readText(resolve(root, "SECURITY.md"), "security policy");
const mcpSource = readText(resolve(root, "src/mcp.ts"), "MCP server source");
const sourceFiles = [
  "src/core/decision.ts",
  "src/core/constraint.ts",
  "src/core/evaluate-condition.ts",
  "src/model/schemas.ts",
].map((path) => readText(resolve(root, path), `source file ${path}`));

const repositoryUrl = "https://github.com/tetracoralla/decision-table";
if (packageJson.name !== "@openadam/decision-table") failures.push("npm package identity differs");
if (packageJson.private !== true) failures.push("Node package must stay private to prevent npm publication");
if (packageJson.repository?.url !== `git+${repositoryUrl}.git`) failures.push("npm repository identity differs");
if (packageJson.bin?.["decision-table"] !== "dist/cli.js") failures.push("CLI identity differs");
if (packageJson.bin?.["decision-table-mcp"] !== "dist/mcp.js") failures.push("MCP CLI identity differs");
if (pluginJson.name !== "decision-table") failures.push("plugin identity differs");
if (pluginJson.interface?.displayName !== "Decision Table") failures.push("plugin display name differs");
if (pluginJson.repository !== repositoryUrl) failures.push("plugin repository identity differs");
if (!skillMetadata.includes('display_name: "Decision Table"')) failures.push("Skill display name differs");
if (!readme.startsWith("# Decision Table\n")) failures.push("README product name differs");
for (const required of [
  "Display name: **Decision Table**",
  "`@openadam/decision-table`",
  "`decision-table-mcp`",
  "`use-decision-table`",
  "`decision_table`",
  "`DECISION_TABLE_APPROVED_CONSTRAINT_JSON`",
]) {
  if (!identity.includes(required)) failures.push(`product identity contract omits ${required}`);
}
if (!identity.includes("is not an npm\ndistribution channel")) {
  failures.push("product identity contract must exclude npm distribution");
}
for (const required of [
  "codex plugin marketplace add tetracoralla/decision-table --ref main",
  "codex plugin add decision-table@decision-table",
  "not published to npm",
]) {
  if (!readme.includes(required)) failures.push(`README omits distribution contract: ${required}`);
}
if (!installation.includes("codex plugin marketplace upgrade decision-table")) {
  failures.push("installation guide omits marketplace update path");
}
if (!license.includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION")) {
  failures.push("repository must contain the complete Apache-2.0 license text");
}
if (!security.includes("private vulnerability reporting")) {
  failures.push("security policy omits private reporting path");
}
if (pluginJson.version !== packageJson.version) failures.push("plugin and package versions differ");
if (skill.includes("[TODO:")) failures.push("product Skill contains TODO placeholders");
for (const name of ["decision.evaluate", "decision.validate", "constraint.check"]) {
  if (!mcpSource.includes(`\"${name}\"`)) failures.push(`missing public tool ${name}`);
}
if (!mcpSource.includes('"constraint.check_approved"')) failures.push("missing approved-policy check tool");
if (packageJson.scripts?.publish) failures.push("npm publish script is not allowed");
if (sourceFiles.some((source) => /\beval\s*\(|new\s+Function\s*\(/.test(source))) {
  failures.push("forbidden raw source evaluation found");
}
const serverConfig = mcpJson.mcpServers?.decision_table;
if (!serverConfig) failures.push("plugin MCP server decision_table is not configured");
if (serverConfig?.cwd !== ".") failures.push("plugin MCP cwd must be the plugin root");
const serverEntry = serverConfig?.args?.[0];
if (!serverEntry || !existsSync(resolve(pluginRoot, serverEntry))) failures.push("built plugin server entry is missing");

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`contract failure: ${failure}\n`);
  process.exit(1);
}
process.stdout.write("contract checks passed\n");
