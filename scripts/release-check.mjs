import { execFileSync } from "node:child_process";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readJson(file) {
  return JSON.parse(await readFile(path.join(root, file), "utf-8"));
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const [packageJson, packageLock, pluginManifest, changelog] = await Promise.all([
  readJson("package.json"),
  readJson("package-lock.json"),
  readJson("openclaw.plugin.json"),
  readFile(path.join(root, "CHANGELOG.md"), "utf-8")
]);

const version = packageJson.version;
requireCondition(/^\d+\.\d+\.\d+$/.test(version), `Package version is not stable semver: ${version}`);
requireCondition(packageLock.version === version, "package-lock.json root version does not match package.json.");
requireCondition(packageLock.packages?.[""]?.version === version, "package-lock.json package version does not match package.json.");
requireCondition(pluginManifest.version === version, "openclaw.plugin.json version does not match package.json.");
requireCondition(packageJson.private === true, "Package must remain private to prevent accidental npm publishing.");
requireCondition(changelog.includes(`## ${version}`), `CHANGELOG.md does not contain release ${version}.`);

const migrationFile = `docs/project-supervisor/MIGRATION_${version}.md`;
const requiredPackageFiles = ["dist", "openclaw.plugin.json", "README.md", "CHANGELOG.md", migrationFile];
for (const file of requiredPackageFiles) {
  requireCondition(packageJson.files?.includes(file), `package.json files is missing ${file}.`);
}

await Promise.all([
  access(path.join(root, "dist", "index.js")),
  access(path.join(root, "dist", "supervisor.js")),
  access(path.join(root, migrationFile))
]);

async function listFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(entryPath));
    else output.push(entryPath);
  }
  return output;
}

const distFiles = await listFiles(path.join(root, "dist"));
requireCondition(!distFiles.some((file) => /\.test\.(?:js|d\.ts|map)$/.test(file)), "dist contains test artifacts.");

execFileSync("git", ["diff", "--check"], { cwd: root, stdio: "inherit" });
process.stdout.write(`Release metadata verified for ${version}.\n`);
