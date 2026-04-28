import path from "node:path";
import {
  assert,
  normalizeColor,
  normalizeDescription,
  readJsonc,
  writeJsoncPreservingHeader,
} from "./lib/config-utils.mjs";
import { validateDeleteLabels, validateProperties } from "./lib/config-validation.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelsPath = path.join(workspaceRoot, "config", "labels.jsonc");
const autoPrunedLabelsPath = path.join(workspaceRoot, "config", "auto-pruned-labels.jsonc");

async function githubRequest(token, method, apiPath) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "label-sync-config",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${method} ${apiPath} failed with ${response.status}: ${message}`);
  }

  return response.json();
}

async function getAllLabels(token, repo) {
  const labels = [];
  let page = 1;

  while (true) {
    const batch = await githubRequest(token, "GET", `/repos/${repo}/labels?per_page=100&page=${page}`);
    labels.push(...batch);

    if (batch.length < 100) {
      return labels;
    }

    page += 1;
  }
}

function toManagedLabels(labels) {
  return labels
    .map((label) => ({
      name: label.name.trim(),
      color: normalizeColor(label.color),
      description: normalizeDescription(label.description),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function main() {
  const token = process.env.CONFIG_LABEL_SYNC_TOKEN ?? process.env.GITHUB_TOKEN;
  assert(token, "CONFIG_LABEL_SYNC_TOKEN or GITHUB_TOKEN is required.");

  const properties = validateProperties(await readJsonc(propertiesPath), {
    includeSourceRepository: true,
    defaultSourceRepository: process.env.GITHUB_REPOSITORY ?? "",
  });
  const repository = process.env.SOURCE_REPOSITORY ?? properties.sourceRepository;
  assert(repository, "SOURCE_REPOSITORY or GITHUB_REPOSITORY is required.");

  const deleteLabels = validateDeleteLabels(await readJsonc(autoPrunedLabelsPath));
  const repositoryLabels = await getAllLabels(token, repository);
  const managedLabels = toManagedLabels(repositoryLabels);

  await writeJsoncPreservingHeader(labelsPath, managedLabels);

  console.log(
    `Synced ${managedLabels.length} managed labels from ${repository} into config/labels.jsonc. Source labels take precedence over ${deleteLabels.length} exact auto-pruned label specs.`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
