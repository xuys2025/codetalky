// The branch a project is on, read straight from .git (no git process per hook event).

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** The checked-out branch of the repository containing dir; undefined outside one or when detached. */
export function gitBranch(dir: string): string | undefined {
  let d = resolve(dir);
  for (;;) {
    const git = join(d, '.git');
    try {
      let head: string;
      if (statSync(git).isDirectory()) {
        head = readFileSync(join(git, 'HEAD'), 'utf8');
      } else {
        // A worktree or submodule: .git is a file pointing at the real git dir.
        const gitdir = /gitdir:\s*(.+)/.exec(readFileSync(git, 'utf8'))?.[1]?.trim();
        if (!gitdir) return undefined;
        head = readFileSync(join(resolve(d, gitdir), 'HEAD'), 'utf8');
      }
      return /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim();
    } catch {
      // no .git here: look further up
    }
    const up = dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}
