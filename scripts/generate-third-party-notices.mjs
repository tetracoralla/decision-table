import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function packageRootFromInput(repositoryRoot, inputPath) {
  const normalized = relative(
    repositoryRoot,
    resolve(repositoryRoot, inputPath),
  ).split(sep).join("/");
  const marker = "node_modules/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return undefined;
  const packagePath = normalized.slice(markerIndex + marker.length).split("/");
  const packageSegments = packagePath[0]?.startsWith("@")
    ? packagePath.slice(0, 2)
    : packagePath.slice(0, 1);
  if (packageSegments.length === 0 || packageSegments.some((segment) => !segment)) {
    throw new Error(`Cannot identify bundled package for ${inputPath}.`);
  }
  return resolve(
    repositoryRoot,
    normalized.slice(0, markerIndex),
    marker,
    ...packageSegments,
  );
}

async function legalFiles(packageRoot) {
  const entries = await readdir(packageRoot, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^(?:licen[cs]e|copying|notice|copyright)(?:\..+)?$/iu.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort(compareCodeUnits);
}

export async function writeThirdPartyNotices({
  repositoryRoot,
  bundledInputs,
  outputPaths,
  productName,
}) {
  const dependencyRoot = await realpath(resolve(repositoryRoot, "node_modules"));
  const roots = new Set();
  for (const inputPath of bundledInputs) {
    const packageRoot = packageRootFromInput(repositoryRoot, inputPath);
    if (packageRoot === undefined) continue;
    const resolvedPackageRoot = await realpath(packageRoot);
    if (
      resolvedPackageRoot !== dependencyRoot &&
      !resolvedPackageRoot.startsWith(`${dependencyRoot}${sep}`)
    ) {
      throw new Error(`Bundled dependency resolved outside node_modules: ${inputPath}.`);
    }
    roots.add(resolvedPackageRoot);
  }

  const packages = [];
  for (const packageRoot of [...roots].sort()) {
    const packageJson = JSON.parse(
      await readFile(resolve(packageRoot, "package.json"), "utf8"),
    );
    if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
      throw new Error(`Bundled package at ${packageRoot} has no stable name and version.`);
    }
    const files = await legalFiles(packageRoot);
    if (!files.some((file) => /^(?:licen[cs]e|copying)(?:\..+)?$/iu.test(file))) {
      throw new Error(
        `Bundled package ${packageJson.name}@${packageJson.version} has no license text.`,
      );
    }
    packages.push({
      name: packageJson.name,
      version: packageJson.version,
      declaredLicense:
        typeof packageJson.license === "string"
          ? packageJson.license
          : "See included text",
      legalFiles: await Promise.all(
        files.map(async (file) => ({
          file,
          text: (await readFile(resolve(packageRoot, file), "utf8"))
            .replace(/\r\n?/g, "\n")
            .trim(),
        })),
      ),
    });
  }
  packages.sort((left, right) =>
    compareCodeUnits(`${left.name}@${left.version}`, `${right.name}@${right.version}`),
  );
  if (packages.length === 0) {
    throw new Error("The plugin bundle contains no attributable third-party packages.");
  }

  const sections = packages.map((item) =>
    [
      `## ${item.name}@${item.version}`,
      "",
      `Declared license: ${item.declaredLicense}`,
      "",
      ...item.legalFiles.flatMap((legalFile) => [
        `### ${legalFile.file}`,
        "",
        legalFile.text,
        "",
      ]),
    ].join("\n"),
  );
  const content = [
    "# Third-party notices",
    "",
    `${productName}'s standalone Codex plugin bundles the packages below. ` +
      "The license and notice texts are preserved from the exact installed package versions used by the build.",
    "",
    ...sections,
  ].join("\n").trimEnd() + "\n";

  for (const outputPath of outputPaths) {
    await writeFile(outputPath, content, "utf8");
  }
  return packages.map(({ name, version }) => ({ name, version }));
}
