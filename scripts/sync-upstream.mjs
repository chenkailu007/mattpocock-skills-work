import { execFileSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_VERSION = 1;
const UPSTREAM_URL = "https://github.com/mattpocock/skills.git";
const UPSTREAM_WEB_URL = "https://github.com/mattpocock/skills";
const UPSTREAM_REF = "main";
const ALLOWED_BUCKETS = new Set(["engineering", "productivity"]);
const CLAUDE_ONLY_FRONTMATTER = new Set([
  "argument-hint",
  "disable-model-invocation",
]);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const pluginRoot = path.join(root, "plugins", "mattpocock-skills");
const skillsRoot = path.join(pluginRoot, "skills");

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeNewlines(content) {
  return content.replace(/\r\n/g, "\n");
}

function stripClaudeOnlyFrontmatter(content, skillName) {
  const normalized = normalizeNewlines(content);
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n/);
  assert(match, `${skillName}: SKILL.md has no valid frontmatter`);

  const cleanedLines = match[1].split("\n").filter((line) => {
    const key = line.match(/^([a-zA-Z0-9_-]+):/)?.[1];
    return !key || !CLAUDE_ONLY_FRONTMATTER.has(key);
  });
  const cleaned = `---\n${cleanedLines.join("\n")}\n---\n${normalized.slice(match[0].length)}`;

  for (const key of CLAUDE_ONLY_FRONTMATTER) {
    assert(
      !new RegExp(`^${key}:`, "m").test(cleaned),
      `${skillName}: failed to remove Claude-only frontmatter ${key}`,
    );
  }
  return cleaned;
}

function replaceExactly(content, before, after, label) {
  assert(content.includes(before), `Expected adapter source was not found: ${label}`);
  return content.replace(before, after);
}

function adaptSkillInvocations(content, skillNames) {
  let adapted = content;
  for (const skillName of skillNames) {
    adapted = adapted.replaceAll(`\`/${skillName}\``, `\`${skillName}\``);
    const escapedName = skillName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    adapted = adapted.replace(
      new RegExp(`/${escapedName}(?![a-zA-Z0-9_/<-])`, "g"),
      `\`${skillName}\``,
    );
  }
  return adapted
    .replace(
      "Then use the Agent tool with `subagent_type=Explore` to walk the codebase.",
      "Then use an exploration-focused subagent to walk the codebase.",
    )
    .replace(
      "Spawn 3+ sub-agents in parallel using the Agent tool.",
      "Spawn 3+ subagents in parallel using the available subagent mechanism.",
    )
    .replace(
      "Send a single message with two `Agent` tool calls. Use the `general-purpose` subagent for both.",
      "Dispatch two general-purpose subagents in parallel.",
    );
}

function adaptSetupSkill(content) {
  let adapted = replaceExactly(
    content,
    "- The `## Agent skills` block to add to whichever of `CLAUDE.md` / `AGENTS.md` is being edited (see step 4 for selection rules)",
    "- The `## Agent skills` block to add to `AGENTS.md`",
    "setup draft target",
  );
  adapted = replaceExactly(
    adapted,
    `**Pick the file to edit:**

- If \`CLAUDE.md\` exists, edit it.
- Else if \`AGENTS.md\` exists, edit it.
- If neither exists, ask the user which one to create; don't pick for them.

Never create \`AGENTS.md\` when \`CLAUDE.md\` already exists (or vice versa); always edit the one that's already there.`,
    `**Pick the file to edit:**

- If \`AGENTS.md\` exists, edit it.
- Otherwise, create \`AGENTS.md\`.
- Leave \`CLAUDE.md\` unchanged unless the user explicitly asks to update it too.`,
    "setup AGENTS.md selection",
  );
  return adapted;
}

function adaptMarkdown(content, skillName, skillNames, isSkillFile) {
  let adapted = isSkillFile
    ? stripClaudeOnlyFrontmatter(content, skillName)
    : normalizeNewlines(content);
  adapted = adaptSkillInvocations(adapted, skillNames);
  if (skillName === "setup-matt-pocock-skills" && isSkillFile) {
    adapted = adaptSetupSkill(adapted);
  }
  assert(
    !/Agent tool|`Agent` tool|subagent_type=/.test(adapted),
    `${skillName}: contains an unadapted Claude subagent instruction`,
  );
  return adapted;
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

function pluginManifest(upstreamManifest, commitTimestamp) {
  assert(
    /^\d+\.\d+\.\d+$/.test(upstreamManifest.version),
    `Unsupported upstream plugin version: ${upstreamManifest.version}`,
  );
  return {
    name: "mattpocock-skills",
    version: `${upstreamManifest.version}-work.${commitTimestamp}`,
    description:
      "Matt Pocock's promoted engineering and productivity skills, adapted for ChatGPT Work.",
    author: upstreamManifest.author,
    homepage: UPSTREAM_WEB_URL,
    repository: "https://github.com/chenkailu007/mattpocock-skills-work",
    license: "MIT",
    keywords: [...new Set([...(upstreamManifest.keywords ?? []), "chatgpt-work"])],
    skills: "./skills/",
    interface: {
      displayName: "Matt Pocock Skills",
      shortDescription: "Engineering workflows for real projects",
      longDescription:
        "Promoted Matt Pocock engineering and productivity skills with deterministic ChatGPT Work adaptations and traceable upstream provenance.",
      developerName: "Matt Pocock; ChatGPT Work adapter by chenkailu007",
      category: "Productivity",
      capabilities: ["Read", "Write"],
      websiteURL: UPSTREAM_WEB_URL,
      defaultPrompt: [
        "Help me choose the right engineering workflow.",
        "Diagnose this bug with a tight feedback loop.",
        "Review this change against its spec and standards.",
      ],
    },
  };
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "mattpocock-skills-"));
  const upstreamRoot = path.join(temporaryRoot, "upstream");
  const stageRoot = path.join(root, ".sync-stage");

  try {
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--branch", UPSTREAM_REF, UPSTREAM_URL, upstreamRoot],
      { stdio: "inherit" },
    );

    const commit = runGit(["rev-parse", "HEAD"], upstreamRoot);
    const commitTimestamp = Number(
      runGit(["show", "-s", "--format=%ct", "HEAD"], upstreamRoot),
    );
    const commitTime = new Date(commitTimestamp * 1000).toISOString();
    assert(/^[0-9a-f]{40}$/.test(commit), `Invalid upstream commit: ${commit}`);
    assert(Number.isInteger(commitTimestamp), "Invalid upstream commit timestamp");

    const upstreamManifest = JSON.parse(
      await readFile(
        path.join(upstreamRoot, ".claude-plugin", "plugin.json"),
        "utf8",
      ),
    );
    assert(
      Array.isArray(upstreamManifest.skills) && upstreamManifest.skills.length > 0,
      "Upstream Claude manifest has no explicit skills list",
    );

    const selected = upstreamManifest.skills.map((relativePath) => {
      const normalized = relativePath.replaceAll("\\", "/");
      const match = normalized.match(
        /^\.\/skills\/([^/]+)\/([^/]+)$/,
      );
      assert(match, `Unsupported upstream skill path: ${relativePath}`);
      const [, bucket, name] = match;
      assert(ALLOWED_BUCKETS.has(bucket), `Unapproved skill bucket: ${bucket}`);
      return { bucket, name, relativePath: normalized };
    });
    assert(
      new Set(selected.map(({ name }) => name)).size === selected.length,
      "Duplicate promoted skill names",
    );
    const skillNames = selected.map(({ name }) => name);

    await rm(stageRoot, { recursive: true, force: true });
    await mkdir(path.join(stageRoot, "skills"), { recursive: true });

    for (const skill of selected) {
      const source = path.join(
        upstreamRoot,
        "skills",
        skill.bucket,
        skill.name,
      );
      const destination = path.join(stageRoot, "skills", skill.name);
      const sourceSkillFile = path.join(source, "SKILL.md");
      const sourceOpenAiMetadata = path.join(source, "agents", "openai.yaml");

      await readFile(sourceSkillFile, "utf8");
      await readFile(sourceOpenAiMetadata, "utf8");
      await cp(source, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });

      for (const markdownFile of await markdownFiles(destination)) {
        const markdown = await readFile(markdownFile, "utf8");
        await writeFile(
          markdownFile,
          adaptMarkdown(
            markdown,
            skill.name,
            skillNames,
            path.basename(markdownFile) === "SKILL.md",
          ),
          "utf8",
        );
      }
    }

    await rm(skillsRoot, { recursive: true, force: true });
    await mkdir(pluginRoot, { recursive: true });
    await rename(path.join(stageRoot, "skills"), skillsRoot);
    await rm(stageRoot, { recursive: true, force: true });

    await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    const manifest = pluginManifest(upstreamManifest, commitTimestamp);
    await writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await cp(
      path.join(upstreamRoot, "LICENSE"),
      path.join(pluginRoot, "LICENSE"),
      { force: true },
    );
    await writeFile(
      path.join(pluginRoot, "README.md"),
      `# Matt Pocock Skills\n\nGenerated for ChatGPT Work from [mattpocock/skills](${UPSTREAM_WEB_URL}).\n\n- Upstream commit: \`${commit}\`\n- Upstream commit time: \`${commitTime}\`\n- Included skills: ${selected.length}\n\nDo not edit this directory by hand. Run \`npm run sync\` from the marketplace root.\n`,
      "utf8",
    );

    const provenance = {
      schemaVersion: 1,
      upstream: {
        repository: UPSTREAM_WEB_URL,
        ref: UPSTREAM_REF,
        commit,
        commitTime,
        pluginVersion: upstreamManifest.version,
        selectedSkills: selected.map(({ bucket, name, relativePath }) => ({
          bucket,
          name,
          path: relativePath,
        })),
      },
      adapter: {
        repository:
          "https://github.com/chenkailu007/mattpocock-skills-work",
        version: ADAPTER_VERSION,
        generatedPluginVersion: manifest.version,
      },
    };
    await writeFile(
      path.join(root, "upstream.lock.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
      "utf8",
    );

    console.log(
      `Synced ${selected.length} skills from ${commit.slice(0, 12)} as ${manifest.version}`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(stageRoot, { recursive: true, force: true });
  }
}

await main();
