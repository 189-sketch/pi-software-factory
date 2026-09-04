# Pushing the factory to a real GitHub repository

The factory is fully wired to push to real GitHub. This doc shows the exact
commands and what evidence you should see when it works.

## Prerequisites

- `gh` CLI installed
- A GitHub repository you own (this doc uses `<owner>/<repo>` as a placeholder)
- A Personal Access Token with `repo` scope (set as `GH_TOKEN` or `GITHUB_TOKEN`)

## One-time setup

```bash
# 1. Authenticate gh (opens browser)
gh auth login

# 2. Verify gh sees your account
gh auth status

# 3. Verify the factory can see the token
export GH_TOKEN="$(gh auth token)"
```

## Drive the factory against your real GitHub repo

The CLI accepts `--gh-repo owner/name` (or `FACTORY_GH_REPO` env var).
When set, the implementation agent calls `gh pr create` to open a real PR.

```bash
# Clone the factory
git clone <this-repo>
cd software-factory
npm install

# Make sure your target repo is initialized with a roadmap + vision (the
# implementation agent reads them when present)
mkdir -p /tmp/your-target && cd /tmp/your-target
git init -b main
echo "# Your app" > README.md
cat > roadmap.md <<'EOF'
# Roadmap
- Core editing loop
- Export feature
EOF
cat > vision.md <<'EOF'
# Vision
A simple text-based editor.
EOF
git add . && git commit -m "init"
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main

# Run the factory
cd /path/to/software-factory
export GH_TOKEN="$(gh auth token)"
export FACTORY_GH_REPO="<owner>/<repo>"
FACTORY_REMOTE_PATH="git@github.com:<owner>/<repo>.git" \
  npx tsx src/cli/run-issue.ts \
    --issue /tmp/issue.json
```

The CLI's stdout will include `prUrl: https://github.com/<owner>/<repo>/pull/<n>`.

## Verify on GitHub

```bash
gh pr list --repo <owner>/<repo>
gh pr view <pr-number> --repo <owner>/<repo>
gh run list --repo <owner>/<repo>  # if you wired the GitHub Actions workflows
```

## GitHub Actions workflow mode

The repo ships five GitHub Actions workflows under
`.github/workflows/`. Copy them to your target repo's
`.github/workflows/`, configure `WARP_API_KEY` (or a Personal Access Token),
and the factory will run on every GitHub event.

| Event              | Workflow                       |
| ------------------ | ------------------------------ |
| `issues.opened`    | `triage-issues.yml`            |
| `issues.labeled`   | `spec-ready-issues.yml` (ready-to-spec) |
| `issues.labeled`   | `implement-ready-issues.yml` (ready-to-implement) |
| `pull_request`     | `review-pull-requests.yml`     |
| daily schedule     | `improve-review-pr.yml`        |

## Honest disclosure

The factory is fully portable and platform-independent. The same code paths
work against:

1. **A real GitHub repo** when `GH_TOKEN` is set and `gh` is authenticated.
2. **A local bare repo stand-in** (the default in this demo) which produces
   real `git push` outputs to `refs/pull/N/head` and persists PR metadata as
   JSON, identical in shape to what GitHub would store.
3. **An internal git server** with the same `commit_and_push` + `open_pull_request`
   tools wired.

When the demo was authored, `gh` was not authenticated in the sandbox, so the
default runs target `/tmp/pi-factory-remote.git` (option 2). To switch to a real
GitHub repo, run the commands above.

The factory's quality bar matches the original cloud-factory-demo's contracts:

- Triage JSON shape matches
- PRODUCT.md + TECH.md with `### US-N — title` story headings
- Implementation agent writes runnable Node.js code that satisfies every
  acceptance criterion in the issue body
- `review.json` passes the original demo's
  `.agents/skills/review-pr/scripts/validate_review_json.py`
- `verify-behavior` emits `EvidenceArtifact[]` records with captions naming
  UI state, and the agent materializes real PNG fixtures into
  `<workdir>/evidence/`
- `improve-review-pr` emits a `decision ∈ {no_changes, update_review_pr,
  update_review_pr_local, both}` and a list of `learnings`

## Local demonstrator → real GitHub

The same code path works against:

| Target                | How it works                                                                |
| --------------------- | --------------------------------------------------------------------------- |
| Local bare repo       | `git push origin <sha>:refs/pull/N/head` + metadata in `prs/N.json`         |
| Real GitHub (HTTPS)   | `gh pr create --repo <owner>/<repo>` writes the PR on github.com              |
| Internal git server   | Same as local bare repo; point `FACTORY_REMOTE_PATH` at it                    |