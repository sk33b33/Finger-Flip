import fs from 'node:fs';
import path from 'node:path';

/**
 * Where Chromium is, today.
 *
 * Every browser tool here used to hardcode a path. It had to: this container
 * ships its own Chromium and sets PLAYWRIGHT_BROWSERS_PATH at it, and the
 * build it ships is not the one the pinned Playwright would download.
 *
 * The trouble is that the path carries a build number, and the container is
 * rebuilt from time to time with a newer one. When that happens every tool
 * breaks at once, with an ENOENT that reads like a Playwright problem rather
 * than a container problem. It has already happened once: the tools were
 * pinned to 1194, Playwright 1.49 wanted 1148, and the container had moved on
 * to 1243. Three numbers, no two the same.
 *
 * So: look. The directory layout changes too — older builds use chrome-linux/
 * and newer ones chrome-linux64/ — hence the search rather than a template.
 */

const ROOT = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

/** @returns {string|undefined} a path, or undefined to let Playwright choose. */
export function chromePath(root = ROOT) {
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return undefined;
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.startsWith('chromium-')) continue;
    const build = Number(entry.slice('chromium-'.length));
    if (!Number.isFinite(build)) continue;
    for (const layout of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = path.join(root, entry, layout);
      if (fs.existsSync(candidate)) {
        found.push({ build, candidate });
        break;
      }
    }
  }

  if (!found.length) return undefined;
  // Newest build. A container with two of them has just been upgraded, and the
  // older one is on its way out.
  found.sort((a, b) => b.build - a.build);
  return found[0].candidate;
}

/**
 * Launch options for a headless browser here, ready to spread into launch().
 *
 * `gpu` adds the SwiftShader flags, which every tool that renders the game
 * needs and the ones that only draw on a canvas do not.
 */
export function launchOptions({ gpu = true } = {}) {
  const executablePath = chromePath();
  const args = ['--no-sandbox'];
  if (gpu) args.unshift('--use-gl=swiftshader', '--enable-unsafe-swiftshader');
  return executablePath ? { executablePath, args } : { args };
}
