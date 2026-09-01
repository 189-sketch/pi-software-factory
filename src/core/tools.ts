import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentContext } from "./types.js";
import type { AgentTool } from "./agent.js";
import { commitAndPush, openPullRequest } from "../github/git.js";

const exec = promisify(execFile);

/**
 * The tool registry shared by every agent.
 *
 * Concrete agents register only the tools they actually need via the BaseAgent
 * `tools_` constructor argument. The tools below are the same primitives a
 * developer would use: read a file, write a file, run a shell command, grep
 * the repo, search the issue tracker.
 */
export function defaultTools(ctx: AgentContext): AgentTool[] {
  return [
    readFileTool(ctx),
    writeFileTool(ctx),
    listDirTool(ctx),
    runShellTool(ctx),
    grepTool(ctx),
    fetchIssueTool(ctx),
    postIssueCommentTool(ctx),
    updateIssueLabelsTool(ctx),
  ];
}

/** Reads a file under the repo working directory. Returns empty string + flag when missing. */
function readFileTool(ctx: AgentContext): AgentTool {
  return {
    name: "read_file",
    description: "Read a UTF-8 file from the repository. Args: { path: string }",
    async execute(args, c) {
      const rel = String(args.path ?? "");
      const abs = path.join(c.repo.workdir, rel);
      try {
        const body = await fs.readFile(abs, "utf-8");
        return { content: body, exists: true, path: rel };
      } catch (err: unknown) {
        return { content: "", exists: false, path: rel, error: String((err as Error).message ?? err) };
      }
    },
  };
}

/** Writes a file under the repo working directory. */
function writeFileTool(ctx: AgentContext): AgentTool {
  return {
    name: "write_file",
    description: "Write a UTF-8 file. Args: { path: string, content: string }",
    async execute(args, c) {
      const rel = String(args.path ?? "");
      const abs = path.join(c.repo.workdir, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, String(args.content ?? ""), "utf-8");
      return { written: rel, bytes: Buffer.byteLength(String(args.content ?? ""), "utf-8") };
    },
  };
}

/** Lists directory entries (relative to repo working dir). Returns empty list when missing. */
function listDirTool(ctx: AgentContext): AgentTool {
  return {
    name: "list_dir",
    description: "List entries under a directory. Args: { path: string }",
    async execute(args, c) {
      const rel = String(args.path ?? ".");
      const abs = path.join(c.repo.workdir, rel);
      try {
        const entries = await fs.readdir(abs, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
      } catch (err: unknown) {
        return [];
      }
    },
  };
}

/** Runs a shell command in the repo working dir. Returns stdout/stderr/exit. */
function runShellTool(ctx: AgentContext): AgentTool {
  return {
    name: "run_shell",
    description: "Run a shell command. Args: { command: string, cwd?: string, timeoutMs?: number }",
    async execute(args, c) {
      const cmd = String(args.command ?? "");
      const cwd = args.cwd ? path.join(c.repo.workdir, String(args.cwd)) : c.repo.workdir;
      const timeoutMs = Number(args.timeoutMs ?? 120_000);
      try {
        const { stdout, stderr } = await exec("bash", ["-lc", cmd], { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
        return { stdout, stderr, exitCode: 0 };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? String(err),
          exitCode: typeof e.code === "number" ? e.code : 1,
        };
      }
    },
  };
}

/** Greps the repo for a regex and returns matching lines. */
function grepTool(ctx: AgentContext): AgentTool {
  return {
    name: "grep_repo",
    description: "Grep files for a regex. Args: { pattern: string, glob?: string, max?: number }",
    async execute(args, c) {
      const pattern = String(args.pattern ?? "");
      const glob = args.glob ? String(args.glob) : "*";
      const max = Number(args.max ?? 50);
      try {
        const { stdout } = await exec("grep", ["-rnE", "--include", glob, pattern, c.repo.workdir], {
          maxBuffer: 4 * 1024 * 1024,
        });
        const lines = stdout.split("\n").filter(Boolean);
        return { matches: lines.slice(0, max), total: lines.length };
      } catch (err: unknown) {
        const e = err as { stdout?: string };
        const lines = (e.stdout ?? "").split("\n").filter(Boolean);
        return { matches: lines.slice(0, max), total: lines.length };
      }
    },
  };
}

/** Fetches issue context from the configured tracker (here a local fixture). */
function fetchIssueTool(ctx: AgentContext): AgentTool {
  return {
    name: "fetch_issue",
    description: "Fetch full issue context. Args: { issueNumber: number }",
    async execute(args, c) {
      // The orchestrator passes the issue via ctx; this tool just returns it.
      return { issue: c.issue };
    },
  };
}

/** Posts a comment on the issue. Real impl would call gh; demo impl writes to log. */
function postIssueCommentTool(ctx: AgentContext): AgentTool {
  return {
    name: "post_issue_comment",
    description: "Post a markdown comment on the issue. Args: { body: string }",
    async execute(args, c) {
      const body = String(args.body ?? "");
      c.logger.info(`[post_issue_comment] #${c.issue.number} bytes=${body.length}`);
      return { posted: true, body, issueNumber: c.issue.number };
    },
  };
}

/** Adds or removes labels on the issue. Real impl would call gh. */
function updateIssueLabelsTool(ctx: AgentContext): AgentTool {
  return {
    name: "update_issue_labels",
    description: "Add or remove labels. Args: { add?: string[], remove?: string[] }",
    async execute(args, c) {
      const add = Array.isArray(args.add) ? (args.add as string[]) : [];
      const remove = Array.isArray(args.remove) ? (args.remove as string[]) : [];
      c.logger.info(`[update_issue_labels] add=${add.join(",")} remove=${remove.join(",")}`);
      return { added: add, removed: remove };
    },
  };
}

/** Commit changes on a feature branch and push to origin. Real git, no stubs. */
export function commitAndPushTool(ctx: AgentContext): AgentTool {
  return {
    name: "commit_and_push",
    description: "Commit the working tree on a new branch and push to origin. Args: { branch: string, message: string, files?: string[] }",
    async execute(args, c) {
      const branch = String(args.branch ?? "feature/auto");
      const message = String(args.message ?? "factory commit");
      const files = Array.isArray(args.files) ? (args.files as string[]) : undefined;
      const result = await commitAndPush({ workdir: c.repo.workdir, branch, message, files });
      return result;
    },
  };
}

/** Open a pull request against the configured base branch. Real git push to refs/pull/. */
export function openPullRequestTool(ctx: AgentContext, remotePath: string): AgentTool {
  return {
    name: "open_pull_request",
    description: "Open a pull request. Args: { branch: string, baseBranch?: string, title: string, body: string }",
    async execute(args, c) {
      const branch = String(args.branch ?? "main");
      const baseBranch = String(args.baseBranch ?? c.repo.defaultBranch ?? "main");
      const title = String(args.title ?? "");
      const body = String(args.body ?? "");
      const result = await openPullRequest({
        workdir: c.repo.workdir,
        remotePath,
        branch,
        baseBranch,
        title,
        body,
      });
      return result;
    },
  };
}