// Version arithmetic for `npm run release`. Releases are MAJOR.MINOR.PATCH with no pre-release
// suffixes, so this covers exactly that and refuses anything else.

export const BUMPS = ["patch", "minor", "major"] as const;
export type Bump = (typeof BUMPS)[number];

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(version: string): [number, number, number] {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`"${version}" is not a MAJOR.MINOR.PATCH version`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The version a release names: a bump of `current`, or an exact version given as is. */
export function nextVersion(current: string, target: string): string {
  const [major, minor, patch] = parseVersion(current);
  if (target === "major") return `${major + 1}.0.0`;
  if (target === "minor") return `${major}.${minor + 1}.0`;
  if (target === "patch") return `${major}.${minor}.${patch + 1}`;
  parseVersion(target);
  return target;
}
