import fs from "node:fs/promises";
import path from "node:path";

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "workflow";
}

function formatUtcTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function formatDatePath(date) {
  return date.toISOString().slice(0, 10);
}

function formatWorkflowRunLink(metadata) {
  if (!metadata.serverUrl || !metadata.repository || !metadata.runId) {
    return "Unavailable";
  }

  return `[${metadata.workflowName} #${metadata.runNumber ?? metadata.runId}](${metadata.serverUrl}/${metadata.repository}/actions/runs/${metadata.runId})`;
}

function renderList(items, renderItem) {
  if (items.length === 0) {
    return "";
  }

  return items.map((item) => `- ${renderItem(item)}`).join("\n");
}

export function getWorkflowMetadata(workflowName) {
  return {
    workflowName,
    repository: process.env.GITHUB_REPOSITORY ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runNumber: process.env.GITHUB_RUN_NUMBER ?? "",
    actor: process.env.GITHUB_ACTOR ?? "",
    serverUrl: process.env.GITHUB_SERVER_URL ?? "https://github.com",
  };
}

export async function writeChangelog({ workflowName, introLines, sections, directoryName = "changelogs" }) {
  const changedSections = sections.filter((section) => section.hasChanges);

  if (changedSections.length === 0) {
    console.log("No repository changes detected; changelog was not written.");
    return null;
  }

  const now = new Date();
  const metadata = getWorkflowMetadata(workflowName);
  const datePath = formatDatePath(now);
  const timestamp = formatUtcTimestamp(now);
  const runId = metadata.runId || `${Date.now()}`;
  const fileName = `${timestamp.replace(/[:]/g, "").replace(/Z$/, "z")}-${slugify(workflowName)}-${runId}.md`;
  const changelogDir = path.join(process.cwd(), directoryName, datePath);
  const changelogPath = path.join(changelogDir, fileName);

  const lines = [
    `# ${workflowName} Changelog`,
    "",
    `- Generated: ${timestamp}`,
    `- Workflow run: ${formatWorkflowRunLink(metadata)}`,
    metadata.actor ? `- Actor: ${metadata.actor}` : null,
    ...introLines.map((line) => `- ${line}`),
    "",
    "## Changed Repositories",
    "",
  ].filter((line) => line !== null);

  for (const section of changedSections) {
    lines.push(`### ${section.repository}`);
    lines.push("");
    lines.push(...section.lines);
    lines.push("");
  }

  await fs.mkdir(changelogDir, { recursive: true });
  await fs.writeFile(changelogPath, `${lines.join("\n")}\n`, "utf8");

  console.log(`Wrote changelog to ${path.relative(process.cwd(), changelogPath)}`);
  return changelogPath;
}

export function renderLabelSyncSection(result) {
  const lines = [];

  const created = renderList(
    result.createdLabels,
    (label) => `Created \`${label.name}\` (#${label.color})${label.description ? `: ${label.description}` : ""}`,
  );
  if (created) {
    lines.push("Created labels:");
    lines.push(created);
    lines.push("");
  }

  const updated = renderList(result.updatedLabels, (entry) => {
    const changes = [];

    if (entry.before.name !== entry.after.name) {
      changes.push(`name \`${entry.before.name}\` -> \`${entry.after.name}\``);
    }

    if (entry.before.color !== entry.after.color) {
      changes.push(`color #${entry.before.color} -> #${entry.after.color}`);
    }

    if (entry.before.description !== entry.after.description) {
      changes.push(`description \`${entry.before.description}\` -> \`${entry.after.description}\``);
    }

    return `Updated \`${entry.before.name}\`: ${changes.join(", ")}`;
  });
  if (updated) {
    lines.push("Updated labels:");
    lines.push(updated);
    lines.push("");
  }

  const deletedGithubDefaults = renderList(
    result.deletedGithubDefaultLabels,
    (label) => `Deleted GitHub default label \`${label.name}\``,
  );
  if (deletedGithubDefaults) {
    lines.push("Deleted GitHub default labels:");
    lines.push(deletedGithubDefaults);
    lines.push("");
  }

  const deletedMissing = renderList(
    result.deletedMissingLabels,
    (label) => `Deleted unmanaged label \`${label.name}\``,
  );
  if (deletedMissing) {
    lines.push("Deleted unmanaged labels:");
    lines.push(deletedMissing);
    lines.push("");
  }

  return {
    repository: result.repository,
    hasChanges: result.hasChanges,
    lines: lines.length > 0 ? lines.slice(0, -1) : [],
  };
}

export function renderRemoveLabelsSection(result) {
  const lines = [];

  const removedIssues = renderList(
    result.removedIssues,
    (item) => `Removed \`${item.label}\` from issue [#${item.number}](${item.url})`,
  );
  if (removedIssues) {
    lines.push("Issues:");
    lines.push(removedIssues);
    lines.push("");
  }

  const removedPullRequests = renderList(
    result.removedPullRequests,
    (item) => `Removed \`${item.label}\` from pull request [#${item.number}](${item.url})`,
  );
  if (removedPullRequests) {
    lines.push("Pull requests:");
    lines.push(removedPullRequests);
    lines.push("");
  }

  return {
    repository: result.repository,
    hasChanges: result.removedIssues.length > 0 || result.removedPullRequests.length > 0,
    lines: lines.length > 0 ? lines.slice(0, -1) : [],
  };
}
