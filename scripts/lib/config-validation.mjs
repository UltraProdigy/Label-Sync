import {
  assert,
  normalizeColor,
  normalizeDescription,
  normalizeName,
  normalizeRepositoryRef,
} from "./config-utils.mjs";

function isFullRepositoryName(value) {
  return /^[^/\s]+\/[^/\s]+$/.test(value);
}

function isRepositoryName(value) {
  return /^[^/\s]+$/.test(value);
}

export function validateProperties(properties, options = {}) {
  const {
    requireOrganization = false,
    requireLabelSyncTokenSecretName = false,
    includeSourceRepository = false,
    defaultSourceRepository = "",
    includeDeleteMissingByDefault = false,
  } = options;

  assert(properties && typeof properties === "object" && !Array.isArray(properties), "config/properties.jsonc must contain an object.");

  const validated = {};

  if (requireOrganization) {
    assert(
      typeof properties.organization === "string" && properties.organization.trim(),
      "properties.organization must be a non-empty string.",
    );
    validated.organization = properties.organization.trim();
  }

  if (requireLabelSyncTokenSecretName) {
    assert(
      typeof properties.labelSyncTokenSecretName === "string" && /^[A-Z_][A-Z0-9_]*$/.test(properties.labelSyncTokenSecretName),
      "properties.labelSyncTokenSecretName must look like a GitHub secret name.",
    );
    validated.labelSyncTokenSecretName = properties.labelSyncTokenSecretName.trim();
  }

  if (properties.sourceRepository !== undefined) {
    assert(
      typeof properties.sourceRepository === "string" && /^[^/\s]+\/[^/\s]+$/.test(properties.sourceRepository.trim()),
      "properties.sourceRepository must match owner/repo when provided.",
    );
  }

  if (includeSourceRepository) {
    validated.sourceRepository = (properties.sourceRepository ?? defaultSourceRepository).trim();
  }

  if (properties.deleteMissingByDefault !== undefined) {
    assert(typeof properties.deleteMissingByDefault === "boolean", "properties.deleteMissingByDefault must be a boolean.");
  }

  if (includeDeleteMissingByDefault) {
    validated.deleteMissingByDefault = properties.deleteMissingByDefault ?? false;
  }

  return validated;
}

export function validateLabels(labels) {
  assert(Array.isArray(labels), "config/labels.jsonc must contain an array.");

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

export function validateDeleteLabels(deleteLabels) {
  assert(Array.isArray(deleteLabels), "config/auto-pruned-labels.jsonc must contain an array.");

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

export function assertNoLabelOverlap(desiredLabels, deleteLabels) {
  const desiredKeys = new Set(desiredLabels.map((label) => normalizeName(label.name)));
  const overlaps = deleteLabels.filter((label) => desiredKeys.has(normalizeName(label)));

  assert(
    overlaps.length === 0,
    `Labels cannot exist in both config/labels.jsonc and config/auto-pruned-labels.jsonc: ${overlaps.join(", ")}.`,
  );
}

function validateRepositoryEntries(entries, configKey) {
  assert(Array.isArray(entries), `config/repository-filter.jsonc field "${configKey}" must contain an array.`);

  const seen = new Set();

  return new Set(entries.map((entry, index) => {
    assert(typeof entry === "string" && entry.trim(), `"${configKey}" entry at index ${index} must be a non-empty string.`);

    const name = entry.trim();
    assert(
      isRepositoryName(name) || isFullRepositoryName(name),
      `"${configKey}" entry "${name}" must be either "repo-name" or "owner/repo-name".`,
    );

    const key = normalizeRepositoryRef(name);
    assert(!seen.has(key), `Duplicate "${configKey}" entry detected: "${name}".`);
    seen.add(key);
    return key;
  }));
}

export function validateRepositoryFilter(repositoryFilter) {
  assert(
    repositoryFilter && typeof repositoryFilter === "object" && !Array.isArray(repositoryFilter),
    "config/repository-filter.jsonc must contain an object.",
  );

  if (repositoryFilter.useWhitelist !== undefined) {
    assert(typeof repositoryFilter.useWhitelist === "boolean", 'config/repository-filter.jsonc field "useWhitelist" must be a boolean.');
  }

  return {
    useWhitelist: repositoryFilter.useWhitelist ?? false,
    whitelist: validateRepositoryEntries(repositoryFilter.whitelist ?? [], "whitelist"),
    blacklist: validateRepositoryEntries(repositoryFilter.blacklist ?? [], "blacklist"),
  };
}
