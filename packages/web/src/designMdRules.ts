import type { DesignMdVersion } from "@redline/shared";

export interface RuleOrigin {
  rule: string;
  /** When the rule entered DESIGN.md; undefined while it is only in the editor. */
  createdAt: string | undefined;
}

const bulletRules = (content: string): string[] =>
  content
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim());

/** The rules (bullet lines) of `content`, each dated by the oldest version of its latest unbroken run. `versions` is newest first. */
export function ruleOrigins(content: string, versions: DesignMdVersion[]): RuleOrigin[] {
  const rulesPerVersion = versions.map((version) => ({ createdAt: version.createdAt, rules: new Set(bulletRules(version.content)) }));
  return bulletRules(content).map((rule) => {
    const run = rulesPerVersion.findIndex((version) => !version.rules.has(rule));
    const introducer = rulesPerVersion[(run === -1 ? rulesPerVersion.length : run) - 1];
    return { rule, createdAt: introducer?.createdAt };
  });
}
