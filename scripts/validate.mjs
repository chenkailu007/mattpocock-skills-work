import {
  lstat,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const pluginRoot = path.join(root, "plugins", "mattpocock-skills");
const skillsRoot = path.join(pluginRoot, "skills");
const allowedFrontmatter = new Set([
  "allowed-tools",
  "description",
  "license",
  "metadata",
  "name",
]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertNoSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const stat = await lstat(entryPath);
    assert(!stat.isSymbolicLink(), `Symlink is not allowed: ${entryPath}`);
    if (stat.isDirectory()) {
      await assertNoSymlinks(entryPath);
    }
  }
}

async function markdownFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

function parseFrontmatter(content, skillName) {
  const match = content.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n/);
  assert(match, `${skillName}: missing SKILL.md frontmatter`);
  const keys = match[1]
    .split("\n")
    .map((line) => line.match(/^([a-zA-Z0-9_-]+):/)?.[1])
    .filter(Boolean);
  for (const key of keys) {
    assert(
      allowedFrontmatter.has(key),
      `${skillName}: unsupported frontmatter key ${key}`,
    );
  }
  assert(keys.includes("name"), `${skillName}: missing name`);
  assert(keys.includes("description"), `${skillName}: missing description`);
}

async function main() {
  const manifest = JSON.parse(
    await readFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(path.join(root, "upstream.lock.json"), "utf8"),
  );
  const marketplace = JSON.parse(
    await readFile(
      path.join(root, ".agents", "plugins", "marketplace.json"),
      "utf8",
    ),
  );

  assert(manifest.name === "mattpocock-skills", "Unexpected plugin name");
  assert(
    /^\d+\.\d+\.\d+-work\.\d+$/.test(manifest.version),
    `Invalid generated plugin version: ${manifest.version}`,
  );
  assert(manifest.skills === "./skills/", "Plugin must expose one skills root");
  assert(
    manifest.version === lock.adapter.generatedPluginVersion,
    "Manifest version does not match provenance lock",
  );
  assert(
    /^[0-9a-f]{40}$/.test(lock.upstream.commit),
    "Invalid provenance commit",
  );
  assert(
    marketplace.name === "mattpocock-work",
    "Unexpected marketplace name",
  );
  assert(
    marketplace.plugins?.[0]?.source?.path ===
      "./plugins/mattpocock-skills",
    "Marketplace points to the wrong plugin path",
  );

  const skillDirectories = (await readdir(skillsRoot, {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const expectedSkills = lock.upstream.selectedSkills
    .map(({ name }) => name)
    .sort();
  assert(
    JSON.stringify(skillDirectories) === JSON.stringify(expectedSkills),
    "Generated skills do not match the provenance lock",
  );

  for (const skillName of skillDirectories) {
    const skillDirectory = path.join(skillsRoot, skillName);
    await readFile(
      path.join(skillDirectory, "agents", "openai.yaml"),
      "utf8",
    );
    for (const markdownFile of await markdownFiles(skillDirectory)) {
      const content = await readFile(markdownFile, "utf8");
      if (path.basename(markdownFile) === "SKILL.md") {
        parseFrontmatter(content, skillName);
        assert(
          !/^(argument-hint|disable-model-invocation):/m.test(content),
          `${skillName}: contains Claude-only frontmatter`,
        );
      }
      assert(
        !/Agent tool|`Agent` tool|subagent_type=/.test(content),
        `${skillName}: contains a Claude-specific subagent instruction in ${markdownFile}`,
      );
      for (const selectedSkill of expectedSkills) {
        const escapedName = selectedSkill.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        assert(
          !new RegExp(`/${escapedName}(?![a-zA-Z0-9_/<-])`).test(content),
          `${skillName}: contains an unadapted skill invocation /${selectedSkill} in ${markdownFile}`,
        );
      }
    }
  }

  await assertNoSymlinks(pluginRoot);
  console.log(
    `Validated ${skillDirectories.length} skills from ${lock.upstream.commit.slice(0, 12)}`,
  );
}

await main();
