import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * PHP non-exposure guard (CVE-2026-109618 / CVE-2026-109619).
 *
 * Both are critical unauthenticated-RCE bugs in PHP itself (fixed in
 * 8.5.12 / 8.4.27 / 8.3.36 / 8.2.35). Intent Pay is a Next.js/TypeScript app on
 * Vercel's managed Node.js runtime and ships no PHP. That is a property of the
 * repository, so it is asserted here rather than left as an audit note: if a PHP
 * artifact is ever introduced — a `.php` file, a Composer manifest, a `php.ini`,
 * a container that installs PHP, or a CI job that runs it — this test fails and
 * forces a re-assessment against the then-current PHP advisories.
 */

const root = join(__dirname, "..");

const IGNORED_DIRS = new Set(["node_modules", ".next", ".git", "coverage", "out", "build"]);

/** Every file path under `dir`, skipping build/dependency directories. */
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const PHP_EXTENSIONS = [".php", ".phtml", ".php3", ".php4", ".php5", ".phps", ".pht"];
const PHP_MANIFESTS = ["composer.json", "composer.lock", "php.ini", "artisan", "wp-config.php"];
const PHP_RUNTIME_LAYERS = [
  "Dockerfile",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".php-version",
  "Procfile",
];

describe("PHP non-exposure (CVE-2026-109618 / CVE-2026-109619)", () => {
  const files = walk(root);
  const relative = files.map((f) => f.slice(root.length + 1));

  it("ships no PHP source files", () => {
    const phpFiles = relative.filter((f) => PHP_EXTENSIONS.some((ext) => f.toLowerCase().endsWith(ext)));
    expect(phpFiles, `unexpected PHP source: ${phpFiles.join(", ")}`).toEqual([]);
  });

  it("ships no Composer manifest or PHP configuration", () => {
    const found = relative.filter((f) => PHP_MANIFESTS.includes(f.split("/").pop() ?? ""));
    expect(found, `unexpected PHP manifest: ${found.join(", ")}`).toEqual([]);
  });

  it("ships no container or process manifest that could install PHP", () => {
    const found = relative.filter((f) => {
      const base = f.split("/").pop() ?? "";
      return PHP_RUNTIME_LAYERS.includes(base) || /^Dockerfile\./.test(base);
    });
    expect(found, `unexpected runtime manifest: ${found.join(", ")}`).toEqual([]);
  });

  it("declares no PHP in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
    const text = JSON.stringify(pkg).toLowerCase();
    expect(text.includes("php")).toBe(false);
    expect(existsSync(join(root, "composer.json"))).toBe(false);
  });
});
