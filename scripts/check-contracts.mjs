import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const pluginRoot = resolve(root, "plugin/decision-table");
const pluginJson = JSON.parse(readFileSync(resolve(pluginRoot, ".codex-plugin/plugin.json"), "utf8"));
const mcpJson = JSON.parse(readFileSync(resolve(pluginRoot, ".mcp.json"), "utf8"));
const skill = readFileSync(resolve(pluginRoot, "skills/use-decision-table/SKILL.md"), "utf8");
const mcpSource = readFileSync(resolve(root, "src/mcp.ts"), "utf8");
const sourceFiles = [
  "src/core/decision.ts",
  "src/core/constraint.ts",
  "src/core/evaluate-condition.ts",
  "src/model/schemas.ts",
].map((path) => readFileSync(resolve(root, path), "utf8"));

const failures = [];
if (pluginJson.version !== packageJson.version) failures.push("plugin and package versions differ");
if (skill.includes("[TODO:")) failures.push("product Skill contains TODO placeholders");
for (const name of ["decision.evaluate", "decision.validate", "constraint.check"]) {
  if (!mcpSource.includes(`\"${name}\"`)) failures.push(`missing public tool ${name}`);
}
if (!mcpSource.includes('"constraint.check_approved"')) failures.push("missing approved-policy check tool");
if (!packageJson.files?.includes("plugin")) failures.push("published package omits the Codex plugin");
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
