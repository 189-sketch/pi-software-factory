import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * SkillLoader reads the canonical SKILL.md files used by the agents.
 *
 * Each agent owns one skill file. The agent module passes the skill name and
 * the loader returns the body so the agent can follow it. The pi framework
 * pattern is: agent loop reads the skill, decides which tools to call, and
 * returns the structured result the skill defines.
 */
export class SkillLoader {
  constructor(private readonly skillsRoot: string) {}

  async load(skillName: string): Promise<{ name: string; description: string; body: string }> {
    const file = path.join(this.skillsRoot, skillName, "SKILL.md");
    const raw = await fs.readFile(file, "utf-8");
    return parseFrontmatter(raw);
  }

  async list(): Promise<string[]> {
    const entries = await fs.readdir(this.skillsRoot, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => !n.startsWith("."));
  }
}

function parseFrontmatter(raw: string): { name: string; description: string; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    return { name: "unknown", description: "", body: raw };
  }
  const fm = match[1];
  const body = match[2];
  const fmLines = fm.split("\n");
  const fields: Record<string, string> = {};
  for (const line of fmLines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    fields[key] = val;
  }
  return {
    name: fields.name ?? "unknown",
    description: fields.description ?? "",
    body,
  };
}