import path from "node:path";
import {
  assert,
  normalizeColor,
  normalizeDescription,
  normalizeName,
  normalizeRepositoryRef,
  readJsonc,
} from "./lib/config-utils.mjs";
import {
  assertNoLabelOverlap,
  validateDeleteLabels,
  validateLabels,
  validateProperties,
  validateRepositoryFilter,
} from "./lib/config-validation.mjs";
import { renderLabelSyncSection, writeChangelog } from "./lib/changelog-utils.mjs";

const workspaceRoot = process.cwd();
const propertiesPath = path.join(workspaceRoot, "config", "properties.jsonc");
const labelsPath = path.join(workspaceRoot, "config", "labels.jsonc");
const autoPrunedLabelsPath = path.join(workspaceRoot, "config", "auto-pruned-labels.jsonc");
const repositoryFilterPath = path.join(workspaceRoot, "config", "repository-filter.jsonc");

const validateOnly = process.argv.includes("--validate-only");
const dryRun = validateOnly || process.env.DRY_RUN === "true";
const deleteMissingOverride = parseBoolean(process.env.DELETE_MISSING);
const targetRepositoryFilter = parseRepositoryFilter(process.env.TARGET_REPOSITORIES);

function parseBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return value.toLowerCase() === "true";
}

function parseRepositoryFilter(value) {
  if (!value) {
    return null;
  }

  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

async function githubRequest(token, method, apiPath, body) {
  const response = await fetch(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "label-sync",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`${method} ${apiPath} failed with ${response.status}: ${message}`);
  }

  if (response.status === 204) {
    return null;
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

async function getOrganizationRepositories(token, orgName) {
  const repositories = [];
  let page = 1;

  while (true) {
    const batch = await githubRequest(
      token,
      "GET",
      `/orgs/${orgName}/repos?type=all&per_page=100&page=${page}`,
    );

    repositories.push(...batch);

    if (batch.length < 100) {
      return repositories;
    }

    page += 1;
  }
}

function filterRepositories(repositories, orgName, repositoryFilter) {
  return repositories
    .filter((repository) => {
      const shortName = normalizeRepositoryRef(repository.name);
      const fullName = normalizeRepositoryRef(repository.full_name);
      const orgScopedName = normalizeRepositoryRef(`${orgName}/${repository.name}`);
      const matchesFilter = (entries) => (
        entries.has(shortName) || entries.has(fullName) || entries.has(orgScopedName)
      );

      if (repositoryFilter.useWhitelist) {
        return matchesFilter(repositoryFilter.whitelist);
      }

      return !matchesFilter(repositoryFilter.blacklist);
    })
    .sort((left, right) => left.full_name.localeCompare(right.full_name));
}

function applyTargetRepositoryFilter(repositories) {
  if (!targetRepositoryFilter) {
    return repositories;
  }

  const selected = repositories.filter((repository) => {
    const shortName = normalizeRepositoryRef(repository.name);
    const fullName = normalizeRepositoryRef(repository.full_name);
    return targetRepositoryFilter.has(shortName) || targetRepositoryFilter.has(fullName);
  });

  const available = new Set(
    repositories.flatMap((repository) => [
      normalizeRepositoryRef(repository.name),
      normalizeRepositoryRef(repository.full_name),
    ]),
  );
  const missing = [...targetRepositoryFilter].filter((entry) => !available.has(entry));

  assert(
    missing.length === 0,
    `Requested repositories were not found in the discovered org repository set after repository-filter processing: ${missing.join(", ")}.`,
  );

  return selected;
}

function summarizeLabelDiff(existing, desired) {
  if (!existing) {
    return "create";
  }

  const sameColor = normalizeColor(existing.color) === desired.color;
  const sameDescription = normalizeDescription(existing.description) === desired.description;
  const sameName = existing.name === desired.name;

  if (sameColor && sameDescription && sameName) {
    return "unchanged";
  }

  return "update";
}

async function syncRepository(token, repository, desiredLabels, deleteLabels, deleteMissing) {
  console.log(`\nSyncing ${repository.full_name}`);
  const existingLabels = await getAllLabels(token, repository.full_name);
  const existingByName = new Map(existingLabels.map((label) => [normalizeName(label.name), label]));
  const desiredKeys = new Set(desiredLabels.map((label) => normalizeName(label.name)));
  const deleteKeys = new Set(deleteLabels.map((label) => normalizeName(label)));
  const result = {
    repository: repository.full_name,
    createdLabels: [],
    updatedLabels: [],
    deletedConfiguredLabels: [],
    deletedMissingLabels: [],
    hasChanges: false,
  };

  let created = 0;
  let updated = 0;
  let deletedConfigured = 0;
  let deletedMissing = 0;
  let unchanged = 0;

  for (const desired of desiredLabels) {
    const existing = existingByName.get(normalizeName(desired.name));
    const action = summarizeLabelDiff(existing, desired);

    if (action === "unchanged") {
      unchanged += 1;
      console.log(`  = ${desired.name}`);
      continue;
    }

    if (action === "create") {
      created += 1;
      result.createdLabels.push(desired);
      result.hasChanges = true;
      console.log(`  + ${desired.name}`);

      if (!dryRun) {
        await githubRequest(token, "POST", `/repos/${repository.full_name}/labels`, desired);
      }

      continue;
    }

    updated += 1;
    result.updatedLabels.push({
      before: {
        name: existing.name,
        color: normalizeColor(existing.color),
        description: normalizeDescription(existing.description),
      },
      after: desired,
    });
    result.hasChanges = true;
    console.log(`  ~ ${desired.name}`);

    if (!dryRun) {
      await githubRequest(
        token,
        "PATCH",
        `/repos/${repository.full_name}/labels/${encodeURIComponent(existing.name)}`,
        desired,
      );
    }
  }

  for (const existing of existingLabels) {
    if (!deleteKeys.has(normalizeName(existing.name))) {
      continue;
    }

    deletedConfigured += 1;
    result.deletedConfiguredLabels.push({
      name: existing.name,
      color: normalizeColor(existing.color),
      description: normalizeDescription(existing.description),
    });
    result.hasChanges = true;
    console.log(`  - ${existing.name} (configured delete)`);

    if (!dryRun) {
      await githubRequest(
        token,
        "DELETE",
        `/repos/${repository.full_name}/labels/${encodeURIComponent(existing.name)}`,
      );
    }
  }

  if (deleteMissing) {
    for (const existing of existingLabels) {
      const existingKey = normalizeName(existing.name);

      if (desiredKeys.has(existingKey) || deleteKeys.has(existingKey)) {
        continue;
      }

      deletedMissing += 1;
      result.deletedMissingLabels.push({
        name: existing.name,
        color: normalizeColor(existing.color),
        description: normalizeDescription(existing.description),
      });
      result.hasChanges = true;
      console.log(`  - ${existing.name} (delete missing)`);

      if (!dryRun) {
        await githubRequest(
          token,
          "DELETE",
          `/repos/${repository.full_name}/labels/${encodeURIComponent(existing.name)}`,
        );
      }
    }
  }

  console.log(
    `Summary for ${repository.full_name}: created=${created}, updated=${updated}, deletedConfigured=${deletedConfigured}, deletedMissing=${deletedMissing}, unchanged=${unchanged}`,
  );

  return result;
}

async function main() {
  const properties = validateProperties(await readJsonc(propertiesPath), {
    requireOrganization: true,
    requireLabelSyncTokenSecretName: true,
    includeSourceRepository: true,
    includeDeleteMissingByDefault: true,
  });
  const labels = validateLabels(await readJsonc(labelsPath));
  const deleteLabels = validateDeleteLabels(await readJsonc(autoPrunedLabelsPath));
  assertNoLabelOverlap(labels, deleteLabels);
  const repositoryFilter = validateRepositoryFilter(await readJsonc(repositoryFilterPath));
  const activeFilterCount = repositoryFilter.useWhitelist ? repositoryFilter.whitelist.size : repositoryFilter.blacklist.size;
  const activeFilterMode = repositoryFilter.useWhitelist ? "whitelist" : "blacklist";

  console.log(
    `Loaded ${labels.length} managed labels, ${deleteLabels.length} auto-pruned labels, and ${activeFilterCount} active repository filter entries from config/repository-filter.jsonc (mode=${activeFilterMode}).`,
  );

  if (validateOnly) {
    console.log("Configuration is valid.");
    return;
  }

  const token = process.env.LABEL_SYNC_TOKEN;
  assert(token, "LABEL_SYNC_TOKEN is required unless --validate-only is used.");
  const orgName = process.env.ORG_NAME ?? process.env.GITHUB_REPOSITORY_OWNER ?? properties.organization;
  assert(orgName, "ORG_NAME, GITHUB_REPOSITORY_OWNER, or properties.organization is required to discover organization repositories.");

  const discoveredRepositories = await getOrganizationRepositories(token, orgName);
  const repositories = applyTargetRepositoryFilter(
    filterRepositories(discoveredRepositories, orgName, repositoryFilter),
  );

  console.log(
    `Discovered ${discoveredRepositories.length} repositories in ${orgName}; ${repositories.length} remain after repository-filter processing.`,
  );

  if (repositories.length === 0) {
    console.log("No repositories remain after repository-filter processing and optional subset filtering. Nothing to sync.");
    return;
  }

  console.log(dryRun ? "Running in dry-run mode." : "Applying changes.");
  const deleteMissing = deleteMissingOverride ?? properties.deleteMissingByDefault;
  const results = [];

  for (const repository of repositories) {
    const result = await syncRepository(token, repository, labels, deleteLabels, deleteMissing);
    results.push(result);
  }

  if (!dryRun) {
    await writeChangelog({
      workflowName: "Org-Label-Sync",
      introLines: [
        `Repository filter mode: ${activeFilterMode}`,
        `Processed repositories: ${repositories.length}`,
        `Delete missing labels: ${deleteMissing}`,
      ],
      sections: results.map(renderLabelSyncSection),
    });
    return;
  }

  console.log("Dry-run mode does not write changelogs because no repository changes were applied.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
