// Wayfinder keeps its data in node:sqlite, which works without a flag from Node 22.13 (and 23.4). Older versions fail
// with a cryptic error, so this runs first and says what to do instead.
export function nodeProblem(version: string = process.versions.node): string | null {
  const [major, minor] = version.split('.').map(Number);
  const ok = major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
  return ok ? null : `Wayfinder needs Node 22.13 or newer; you have ${version}. Install the current Node 22 LTS from https://nodejs.org (or with your package manager, nvm or Homebrew), then start Wayfinder again.`;
}

const problem = nodeProblem();
if (problem && !process.env.VITEST) {
  console.error(problem);
  process.exit(1);
}
