import fs from "node:fs/promises";
import path from "node:path";

const workspaceRoot = process.cwd();
const labelsPath = path.join(workspaceRoot, "config", "labels.json");
const deleteLabelsPath = path.join(workspaceRoot, "config", "delete-labels.json");
const repositoriesPath = path.join(workspaceRoot, "config", "repositories.json");

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

function normalizeRepositoryRef(value) {
  return value.trim().toLowerCase();
}

function normalizeColor(color) {
  return color.replace(/^#/, "").toLowerCase();
}

function normalizeDescription(description) {
  return description ?? "";
}

function normalizeName(name) {
  return name.trim().toLowerCase();
}

function isFullRepositoryName(value) {
  return /^[^/\s]+\/[^/\s]+$/.test(value);
}

function isRepositoryName(value) {
  return /^[^/\s]+$/.test(value);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(filePath) {
  const contents = await fs.readFile(filePath, "utf8");
  return JSON.parse(contents);
}

function validateLabels(labels) {
  assert(Array.isArray(labels), "config/labels.json must contain an array.");

  const seen = new Set();

  return labels.map((label, index) => {
    assert(label && typeof label === "object" && !Array.isArray(label), `Label at index ${index} must be an object.`);
    assert(typeof label.name === "string" && label.name.trim(), `Label at index ${index} is missing a valid name.`);
    assert(typeof label.color === "string" && /^[0-9a-fA-F]{6}$/.test(normalizeColor(label.color)), `Label "${label.name}" must have a 6-character hex color.`);

    const key = normalizeName(label.name);
    assert(!seen.has(key), `Duplicate label name detected: "${label.name}".`);
    seen.add(key);

    if (label.description !== undefined) {
      assert(typeof label.description === "string", `Label "${label.name}" has a non-string description.`);
    }

    return {
      name: label.name.trim(),
      color: normalizeColor(label.color),
      description: normalizeDescription(label.description),
    };
  });
}

function validateDeleteLabels(deleteLabels) {
  assert(Array.isArray(deleteLabels), "config/delete-labels.json must contain an array.");

  const seen = new Set();

  return deleteLabels.map((entry, index) => {
    assert(typeof entry === "string" && entry.trim(), `Delete label at index ${index} must be a non-empty string.`);

    const name = entry.trim();
    const key = normalizeName(name);
    assert(!seen.has(key), `Duplicate delete label detected: "${name}".`);
    seen.add(key);
    return name;
  });
}

function assertNoLabelOverlap(desiredLabels, deleteLabels) {
  const desiredKeys = new Set(desiredLabels.map((label) => normalizeName(label.name)));
  const overlaps = deleteLabels.filter((label) => desiredKeys.has(normalizeName(label)));

  assert(
    overlaps.length === 0,
    `Labels cannot exist in both config/labels.json and config/delete-labels.json: ${overlaps.join(", ")}.`,
  );
}

function validateRepositories(config) {
  assert(config && typeof config === "object" && !Array.isArray(config), "config/repositories.json must contain an object.");

  if (config.deleteMissing !== undefined) {
    assert(typeof config.deleteMissing === "boolean", "repositories.deleteMissing must be a boolean.");
  }

  const blacklist = config.blacklist ?? [];
  assert(Array.isArray(blacklist), "repositories.blacklist must be an array.");

  const seen = new Set();
  const normalizedBlacklist = blacklist.map((entry, index) => {
    assert(typeof entry === "string" && entry.trim(), `Blacklist entry at index ${index} must be a non-empty string.`);

    const name = entry.trim();
    assert(
      isRepositoryName(name) || isFullRepositoryName(name),
      `Blacklist entry "${name}" must be either "repo-name" or "owner/repo-name".`,
    );

    const key = normalizeRepositoryRef(name);
    assert(!seen.has(key), `Duplicate blacklist entry detected: "${name}".`);
    seen.add(key);
    return key;
  });

  return {
    deleteMissing: config.deleteMissing ?? false,
    blacklist: new Set(normalizedBlacklist),
  };
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

function filterRepositories(repositories, orgName, blacklist) {
  return repositories
    .filter((repository) => {
      const shortName = normalizeRepositoryRef(repository.name);
      const fullName = normalizeRepositoryRef(repository.full_name);
      const orgScopedName = normalizeRepositoryRef(`${orgName}/${repository.name}`);

      return !blacklist.has(shortName) && !blacklist.has(fullName) && !blacklist.has(orgScopedName);
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
    `Requested repositories were not found in the discovered org repository set after blacklist filtering: ${missing.join(", ")}.`,
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
      console.log(`  + ${desired.name}`);

      if (!dryRun) {
        await githubRequest(token, "POST", `/repos/${repository.full_name}/labels`, desired);
      }

      continue;
    }

    updated += 1;
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
}

async function main() {
  const labels = validateLabels(await readJson(labelsPath));
  const deleteLabels = validateDeleteLabels(await readJson(deleteLabelsPath));
  assertNoLabelOverlap(labels, deleteLabels);
  const repositoryConfig = validateRepositories(await readJson(repositoriesPath));

  console.log(
    `Loaded ${labels.length} managed labels, ${deleteLabels.length} auto-delete labels, and ${repositoryConfig.blacklist.size} blacklist entries.`,
  );

  if (validateOnly) {
    console.log("Configuration is valid.");
    return;
  }

  const token = process.env.LABEL_SYNC_TOKEN;
  assert(token, "LABEL_SYNC_TOKEN is required unless --validate-only is used.");
  const orgName = process.env.ORG_NAME ?? process.env.GITHUB_REPOSITORY_OWNER;
  assert(orgName, "ORG_NAME or GITHUB_REPOSITORY_OWNER is required to discover organization repositories.");

  const discoveredRepositories = await getOrganizationRepositories(token, orgName);
  const repositories = applyTargetRepositoryFilter(
    filterRepositories(discoveredRepositories, orgName, repositoryConfig.blacklist),
  );

  console.log(
    `Discovered ${discoveredRepositories.length} repositories in ${orgName}; ${repositories.length} remain after blacklist filtering.`,
  );

  if (repositories.length === 0) {
    console.log("No repositories remain after blacklist and optional subset filtering. Nothing to sync.");
    return;
  }

  console.log(dryRun ? "Running in dry-run mode." : "Applying changes.");
  const deleteMissing = deleteMissingOverride ?? repositoryConfig.deleteMissing;

  for (const repository of repositories) {
    await syncRepository(token, repository, labels, deleteLabels, deleteMissing);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
