/**
 * Real Git/GitHub adapter.
 *
 * For a real GitHub repo, set GITHUB_TOKEN and the implementation agent will
 * use `gh` to push branches and open PRs. For local development, point the
 * target repo's `origin` at a bare remote (e.g. `/tmp/factory-remote.git`),
 * which this adapter treats as a GitHub stand-in: it pushes branches and
 * records the equivalent of a pull-request as a refs/pull/<n>/head ref.
 */
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface CommitResult {
  branch: string;
  commitSha: string;
  ok: boolean;
}

export interface PullRequestResult {
  prNumber: number;
  prUrl: string;
  headSha: string;
  baseBranch: string;
}

/**
 * Commit the working tree on a new branch and push to origin.
 * Returns the new branch name and commit SHA.
 */
export async function commitAndPush(opts: {
  workdir: string;
  branch: string;
  message: string;
  files?: string[];
}): Promise<CommitResult> {
  const { workdir, branch, message } = opts;
  await exec("git", ["checkout", "-B", branch], { cwd: workdir });
  if (opts.files && opts.files.length > 0) {
    await exec("git", ["add", ...opts.files], { cwd: workdir });
  } else {
    await exec("git", ["add", "-A"], { cwd: workdir });
  }
  // Allow empty commits (e.g. when only a spec file changed and the impl agent
  // already committed earlier); otherwise commit changes.
  try {
    await exec("git", ["commit", "-m", message + "\n\nCo-Authored-By: Cloud Factory Agent <factory@cloud-demo.local>"], { cwd: workdir });
  } catch (err: unknown) {
    const e = err as { stderr?: string };
    if (!/nothing to commit/i.test(e.stderr ?? "")) throw err;
  }
  const { stdout: shaOut } = await exec("git", ["rev-parse", "HEAD"], { cwd: workdir });
  const commitSha = shaOut.trim();
  await exec("git", ["push", "-u", "origin", branch], { cwd: workdir });
  return { branch, commitSha, ok: true };
}

/**
 * Open a "pull request" by creating refs/pull/<n>/head in the bare remote.
 *
 * In a real GitHub deployment the implementation agent would call
 * `gh pr create`. For local development against a bare remote we synthesize
 * the same shape: a numbered PR, a URL that points at the diff between the
 * feature branch and main, and the head SHA.
 */
export async function openPullRequest(opts: {
  workdir: string;
  remotePath: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<PullRequestResult> {
  const { workdir, remotePath, branch, baseBranch, title, body } = opts;
  // Resolve the actual remote name in the workdir (e.g. "origin"). For local
  // bare-repo testing we treat the full path as the remote.
  const remoteName = "origin";
  // Fetch the head SHA from the remote.
  const { stdout: lsOut } = await exec("git", ["ls-remote", remoteName, `refs/heads/${branch}`], { cwd: workdir });
  const headSha = lsOut.split(/\s+/)[0];
  if (!headSha) {
    throw new Error(`branch ${branch} not found on remote ${remoteName}`);
  }
  // Determine the next PR number.
  const { stdout: existingOut } = await exec("git", ["ls-remote", remoteName], { cwd: workdir });
  const numbers = Array.from(existingOut.matchAll(/refs\/pull\/(\d+)\/head/g)).map((m) => Number(m[1]));
  const prNumber = (numbers.length ? Math.max(...numbers) : 100) + 1;
  // Write refs/pull/<n>/head to the bare remote.
  await exec(
    "git",
    ["push", remoteName, `+${headSha}:refs/pull/${prNumber}/head`],
    { cwd: workdir },
  );
  // Also write PR metadata as a file so other steps can read it.
  await fs.mkdir(path.join(remotePath, "prs"), { recursive: true });
  await fs.writeFile(
    path.join(remotePath, "prs", `${prNumber}.json`),
    JSON.stringify({ number: prNumber, branch, baseBranch, title, body, headSha, createdAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  const prUrl = `file://${remotePath.replace(/\.git$/, "")}/pull/${prNumber}`;
  return { prNumber, prUrl, headSha, baseBranch };
}