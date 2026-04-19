# Label Sync

This repository is a standalone source of truth for GitHub labels.

It stores:

- The canonical label definitions in `config/labels.json`
- The repository blacklist in `config/repositories.json`
- A reusable sync script in `scripts/sync-labels.mjs`
- GitHub Actions workflows to validate config and apply label changes

## What This Repo Does

When the sync workflow runs, it:

1. Reads the label definitions from `config/labels.json`
2. Discovers every repository in the organization that owns this repo
3. Excludes any repositories listed in `config/repositories.json`
4. Creates any missing labels in each remaining repository
5. Updates label colors and descriptions when they drift
6. Optionally deletes labels that are no longer in the config

By default, it only creates and updates labels. Deletion is opt-in.

## Repository Layout

```text
.
|-- .github/
|   `-- workflows/
|       |-- sync-labels.yml
|       `-- validate-config.yml
|-- config/
|   |-- labels.json
|   `-- repositories.json
`-- scripts/
    `-- sync-labels.mjs
```

## Initial Setup

1. Fork or clone this repository for the organization that will own the label definitions.
2. Add a repository secret named `LABEL_SYNC_TOKEN`.
3. Give that token access to every repository in the organization you want to manage.
4. Update `config/repositories.json` with any repositories you want to exclude.
5. Update `config/labels.json` with your organization's canonical labels.
6. Run the `Validate Config` workflow or open a pull request.
7. Run the `Sync Labels` workflow manually once to confirm the result.

## Token Guidance

Use either:

- A fine-grained personal access token with access to the target repositories
- A GitHub App installation token surfaced to this workflow by a separate auth step

This starter repo is wired for a repository secret named `LABEL_SYNC_TOKEN`.

## Configuration

### `config/labels.json`

This file contains the labels you want everywhere.

```json
[
  {
    "name": "bug",
    "color": "d73a4a",
    "description": "Something is not working"
  }
]
```

Rules:

- `name` is required
- `color` is required and should be a 6-character hex value
- `description` is optional

### `config/repositories.json`

This file contains the repository blacklist and the global delete behavior.

```json
{
  "deleteMissing": false,
  "blacklist": [
    "sandbox-repo",
    "octo-org/do-not-touch"
  ]
}
```

Notes:

- `deleteMissing` applies to every non-blacklisted repository
- Blacklist entries can be either `repo-name` or `owner/repo-name`
- The org name is discovered from the workflow repository owner
- The workflow dispatch input can temporarily force deletion for a run

## Workflows

### `Validate Config`

Runs on pull requests and manual dispatch. It validates:

- JSON parsing
- Duplicate label names
- Invalid colors
- Invalid repository names

### `Sync Labels`

Runs on:

- Pushes to `main` when label-sync files change
- Manual dispatch
- Weekly schedule

Workflow dispatch inputs:

- `dry_run`: shows planned changes without writing anything
- `delete_missing`: temporarily deletes labels not present in config
- `repositories`: optional comma-separated subset of discovered repositories

## Safe Default Behavior

This repo is intentionally conservative:

- It syncs to the current organization by default, but you can exclude repos with the blacklist
- It does not delete labels unless you explicitly enable that behavior
- It supports dry runs before changing anything

## Suggested Next Edits

- Replace the starter labels with your real org label taxonomy
- Add any repos you want excluded to the blacklist
- Decide whether org-wide `deleteMissing` should stay off
