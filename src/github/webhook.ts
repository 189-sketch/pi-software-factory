import http from "node:http";
import { FactoryOrchestrator } from "../orchestrator/index.js";
import type { Issue, TriageLabel } from "../core/types.js";

/**
 * Minimal webhook server that converts GitHub issue events into orchestrator
 * triggers. Each handler follows the same pattern:
 *  - on `issues.opened` → start triage
 *  - on `issues.labeled` with `ready-to-spec` → start spec
 *  - on `issues.labeled` with `ready-to-implement` → start implementation
 *  - on `pull_request.opened` → run review-pr agent
 *
 * Real deployments should validate the webhook signature against
 * `GITHUB_WEBHOOK_SECRET`. The demo server trusts the local payload.
 */
export interface WebhookOptions {
  port: number;
  orchestrator: FactoryOrchestrator;
}

export function startWebhookServer(opts: WebhookOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url) {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const event = req.headers["x-github-event"];
        const payload = JSON.parse(body || "{}");
        if (event === "issues" && payload.action === "opened") {
          const issue = payloadToIssue(payload.issue);
          await opts.orchestrator.runForIssue(issue);
        } else if (event === "issues" && payload.action === "labeled") {
          const label = payload.label?.name as TriageLabel | undefined;
          const issue = payloadToIssue(payload.issue);
          if (label && (label === "ready-to-spec" || label === "ready-to-implement")) {
            await opts.orchestrator.triggerByLabel(issue, label);
          }
        } else if (event === "pull_request" && payload.action === "opened") {
          const issue = payloadToIssue(payload.pull_request);
          // Reviews run on the PR itself; pass through.
          await opts.orchestrator.triggerByLabel(issue, "ready-to-implement");
        }
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });
  server.listen(opts.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[webhook] listening on http://localhost:${opts.port}/webhook`);
  });
  return server;
}

function payloadToIssue(raw: any): Issue {
  return {
    number: raw.number,
    title: raw.title ?? "",
    body: raw.body ?? "",
    labels: ((raw.labels ?? []) as Array<{ name: string }>).map((l) => l.name as TriageLabel).filter(Boolean),
    author: raw.user?.login ?? "unknown",
    url: raw.html_url ?? "",
    createdAt: raw.created_at ?? new Date().toISOString(),
    comments: [],
  };
}