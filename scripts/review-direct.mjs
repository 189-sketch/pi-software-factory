
      import { ReviewPrAgent } from "../src/agents/review-pr.js";
      import { ConsoleLogger } from "../src/core/log.js";
      const ctx = {
        repo: { owner: "demo", name: "x", defaultBranch: "main", workdir: process.cwd() },
        issue: { number: 99, title: "Test PR", body: "", labels: [], author: "t", url: "", createdAt: "", comments: [] },
        logger: new ConsoleLogger(),
        skillBody: "",
        runId: "test",
      };
      const a = new ReviewPrAgent(ctx);
      const r = await a.run();
      console.log(JSON.stringify(r));
    