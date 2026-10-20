// Fails when a tracked symlink points outside the repo or sits under
// node_modules (issue 745). Committed absolute node_modules symlinks once
// dangled on CI runners and carried a local path into the public mirror.
//
//   node scripts/check-tracked-symlinks.mjs
import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const underNodeModules = (p) => p.split("/").includes("node_modules");

// `links` is [{ path, target }] with repo-relative posix paths. Returns one
// message per offending link; an empty list means the tree is clean.
export function findOffenders(links) {
  const offenders = [];
  for (const { path: linkPath, target } of links) {
    if (underNodeModules(linkPath)) {
      offenders.push(`${linkPath} -> ${target}: tracked symlink under node_modules`);
      continue;
    }
    if (path.posix.isAbsolute(target) || /^[A-Za-z]:[\\/]/.test(target)) {
      offenders.push(`${linkPath} -> ${target}: absolute target`);
      continue;
    }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(linkPath), target));
    if (resolved === ".." || resolved.startsWith("../")) {
      offenders.push(`${linkPath} -> ${target}: points outside the repo`);
    } else if (underNodeModules(resolved)) {
      offenders.push(`${linkPath} -> ${target}: points into node_modules`);
    }
  }
  return offenders;
}

function trackedLinks() {
  const out = execFileSync("git", ["ls-files", "-s", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out
    .split("\0")
    .filter((line) => line.startsWith("120000 "))
    .map((line) => line.slice(line.indexOf("\t") + 1))
    .map((p) => ({ path: p, target: readlinkSync(p) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const offenders = findOffenders(trackedLinks());
  if (offenders.length > 0) {
    console.error(`Tracked symlinks that must not be committed:\n${offenders.map((o) => `  ${o}`).join("\n")}`);
    process.exit(1);
  }
  console.log("No offending tracked symlinks.");
}
