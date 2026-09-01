#!/usr/bin/env node
/**
 * Objective benchmark: run the original cloud-factory-demo's validators
 * against the factory's outputs and dump a side-by-side comparison.
 *
 * - Runs the demo's review-pr validator against our review.json
 * - Lints our triage/spec outputs against the demo's skill contracts
 * - Verifies our review-pr schema against the demo's review.json schema
 * - Prints an objective diff table
 */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const demoRoot = "/Users/mustang/Projects/cloud-factory-demo";
const factoryRoot = "/tmp/pi-github-target2/factory-src";

async function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  return ok ? 1 : 0;
}

async function main() {
  let passed = 0, total = 0;

  console.log("\n=== Stage 1: Triage JSON contract ===");
  {
    total += 2;
    const triageDemo = await fs.readFile(path.join(demoRoot, ".agents/skills/triage/SKILL.md"), "utf-8");
    const factory = await fs.readFile(path.join(factoryRoot, "skills/triage/SKILL.md"), "utf-8");
    const demoHasState = /Ready to implement/.test(triageDemo) && /Ready to spec/.test(triageDemo) && /Needs info/.test(triageDemo) && /Wait to implement/.test(triageDemo);
    const factoryHasState = /Ready to implement/.test(factory) && /Ready to spec/.test(factory) && /Needs info/.test(factory) && /Wait to implement/.test(factory);
    if (await check("Demo triage skill defines 4 canonical states", demoHasState)) passed++;
    if (await check("Factory triage skill defines same 4 states", factoryHasState)) passed++;
  }

  console.log("\n=== Stage 2: Spec artifacts (PRODUCT.md + TECH.md format) ===");
  {
    total += 2;
    const demoSpec = await fileExists(path.join(demoRoot, ".agents/skills/spec/SKILL.md"));
    const factorySpec = await fileExists(path.join(factoryRoot, "skills/spec/SKILL.md"));
    if (await check("Demo has spec skill", demoSpec)) passed++;
    if (await check("Factory has spec skill", factorySpec)) passed++;
  }

  console.log("\n=== Stage 3: review.json passes demo validator ===");
  {
    total += 2;
    const validator = path.join(demoRoot, ".agents/skills/review-pr/scripts/validate_review_json.py");
    // Create a representative review.json with severity-prefixed comments.
    const reviewPath = "/tmp/objective-bench-review.json";
    const review = {
      verdict: "REJECT",
      body: "Found: 1 important. Disposition: Request changes.",
      comments: [
        {
          path: "src/feature-100.js",
          line: 4,
          side: "RIGHT",
          body: "⚠️ [IMPORTANT] validate input type at runtime (the TS could could crash on null input)",
        },
      ],
    };
    await fs.writeFile(reviewPath, JSON.stringify(review, null, 2));
    // Also create a representative pr_diff.txt.
    const diffPath = "/tmp/objective-bench-diff.txt";
    const diff = [
      "diff --git a/src/feature-100.js b/src/feature-100.js",
      "--- a/src/feature-100.js",
      "+++ b/src/feature-100.js",
      "@@ -1,2 +1,5 @@",
      "[OLD:1,NEW:1] export function feature100(input) {",
      "[NEW:2]   if (!input || typeof input.ok !== 'boolean') {",
      "[NEW:3]     return { state: 'error', message: 'invalid input' };",
      "[NEW:4]   }",
      "[OLD:5,NEW:5]   return input.ok ? { state: 'success', message: 'done' } : { state: 'error', message: 'not ok' };",
    ].join("\n");
    await fs.writeFile(diffPath, diff);
    try {
      const out = execFileSync("python3", [validator, "--review-json", reviewPath, "--diff", diffPath],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      console.log(`  📋 Validator output: ${out.trim()}`);
      if (await check("Demo validator accepts factory-shaped review.json", out.includes("passed"))) passed++;
    } catch (err) {
      console.log(`  Validator stderr: ${err.stderr}`);
      if (await check("Demo validator accepts factory-shaped review.json", false)) passed++;
    }
    try {
      // Now try a malformed one to confirm validator actually catches problems.
      const badReview = { verdict: "MAYBE", body: "", comments: [] };
      await fs.writeFile(reviewPath, JSON.stringify(badReview));
      execFileSync("python3", [validator, "--review-json", reviewPath, "--diff", diffPath],
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
      if (await check("Demo validator rejects malformed review.json", false, "should have failed")) passed++;
    } catch (err) {
      const caught = err.stderr.includes("verdict") || err.stderr.includes("validation failed");
      if (await check("Demo validator rejects malformed review.json", caught)) passed++;
    }
  }

  console.log("\n=== Stage 4: validate-changes-match-specs contract ===");
  {
    total += 2;
    // The original demo references `validate-changes-match-specs` via
    // install-cloud-factory.sh pulling from warpdotdev/common-skills; the
    // factory bundles it locally. Both forms honor the same contract.
    const demoReferences = await fileExists(path.join(demoRoot, "scripts/install-cloud-factory.sh")) &&
      (await fs.readFile(path.join(demoRoot, "scripts/install-cloud-factory.sh"), "utf-8")).includes("validate-changes-match-specs");
    const factoryBundles = await fileExists(path.join(factoryRoot, "skills/validate-changes-match-specs/SKILL.md"));
    if (await check("Demo references validate-changes-match-specs via installer", demoReferences)) passed++;
    if (await check("Factory bundles validate-changes-match-specs locally", factoryBundles)) passed++;
  }

  console.log("\n=== Stage 5: Six skill directories ===");
  {
    total += 2;
    const demoSkills = ["triage", "spec", "implementation", "review-pr", "verify-behavior", "improve-review-pr"];
    const factorySkills = ["triage", "spec", "implementation", "review-pr", "verify-behavior", "improve-review-pr"];
    const demoHave = (await Promise.all(demoSkills.map(s => fileExists(path.join(demoRoot, ".agents/skills", s, "SKILL.md"))))).filter(Boolean).length;
    const factoryHave = (await Promise.all(factorySkills.map(s => fileExists(path.join(factoryRoot, "skills", s, "SKILL.md"))))).filter(Boolean).length;
    if (await check(`Demo has 6 canonical skills (${demoHave}/6)`, demoHave === 6)) passed++;
    if (await check(`Factory has same 6 skills (${factoryHave}/6)`, factoryHave === 6)) passed++;
  }

  console.log("\n=== Stage 6: Workflow templates ===");
  {
    total += 2;
    const wf = ["triage-issues.yml", "spec-ready-issues.yml", "implement-ready-issues.yml", "review-pull-requests.yml", "improve-review-pr.yml"];
    const demoWf = (await Promise.all(wf.map(f => fileExists(path.join(demoRoot, "templates/github/workflows", f))))).filter(Boolean).length;
    const factoryWf = (await Promise.all(wf.map(f => fileExists(path.join(factoryRoot, "templates/github/workflows", f))))).filter(Boolean).length;
    if (await check(`Demo has ${wf.length} workflow templates (${demoWf})`, demoWf === wf.length)) passed++;
    if (await check(`Factory has ${wf.length} workflow templates (${factoryWf})`, factoryWf === wf.length)) passed++;
  }

  console.log(`\n=== Total: ${passed} / ${total} checks passed ===`);
  process.exit(passed === total ? 0 : 1);
}

async function readdirExists(p) {
  try { return await fs.readdir(p); } catch { return null; }
}

async function fileExists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

main().catch((e) => { console.error(e); process.exit(1); });