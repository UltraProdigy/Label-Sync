import path from "node:path";
import {
  normalizeName,
  assert,
  normalizeColor,
  normalizeDescription,
  readJsonc,
  writeJsoncPreservingHeader,
} from "./lib/config-utils.mjs";
import { validateDeletedLabels, validateGithubDefaultLabels, validateLabels, validateProperties } from "./lib/config-validation.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelsPath = path.join(workspaceRoot, "config", "labels.jsonc");
const deletedLabelsPath = path.join(workspaceRoot, "config", "deleted-labels.jsonc");
const githubDefaultLabelsPath = path.join(workspaceRoot, "config", "github-default-labels.jsonc");

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

function mergeDeletedLabels(previousManagedLabels, currentManagedLabels, deletedLabels) {
  const currentKeys = new Set(currentManagedLabels.map((label) => normalizeName(label.name)));
  const nextDeletedByName = new Map();

  for (const label of deletedLabels) {
    const key = normalizeName(label.name);
    if (!currentKeys.has(key)) {
      nextDeletedByName.set(key, label);
    }
  }

  for (const label of previousManagedLabels) {
    const key = normalizeName(label.name);
    if (!currentKeys.has(key)) {
      nextDeletedByName.set(key, label);
    }
  }

  return [...nextDeletedByName.values()].sort((left, right) => left.name.localeCompare(right.name));
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

  const previousManagedLabels = validateLabels(await readJsonc(labelsPath));
  const deletedLabels = validateDeletedLabels(await readJsonc(deletedLabelsPath));
  const githubDefaultLabels = validateGithubDefaultLabels(await readJsonc(githubDefaultLabelsPath));
  const repositoryLabels = await getAllLabels(token, repository);
  const managedLabels = toManagedLabels(repositoryLabels);
  const nextDeletedLabels = mergeDeletedLabels(previousManagedLabels, managedLabels, deletedLabels);

  await writeJsoncPreservingHeader(labelsPath, managedLabels);
  await writeJsoncPreservingHeader(deletedLabelsPath, nextDeletedLabels);

  console.log(
    `Synced ${managedLabels.length} managed labels from ${repository} into config/labels.jsonc and tracked ${nextDeletedLabels.length} deleted labels in config/deleted-labels.jsonc. Source labels take precedence over ${githubDefaultLabels.length} exact GitHub default label specs.`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
