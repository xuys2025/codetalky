// Codex changes files with apply_patch, whose input is a patch in its own format:
//
//   *** Begin Patch
//   *** Add File: path          lines that follow start with +
//   *** Update File: path       optionally *** Move to: new/path, then @@ hunks
//   *** Delete File: path
//   *** End Patch

export interface PatchFile {
  path: string;
  st: 'A' | 'M' | 'D';
  /** Set when an update also renames the file. */
  moveTo?: string;
  add: number;
  del: number;
  /** Each hunk's lines, each starting with ' ', '+' or '-'. */
  hunks: string[][];
}

const clean = (line: string) => line.replace(/\r$/, '').replace(/\t/g, '  ');

export function parsePatch(text: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | null = null;
  let hunk: string[] | null = null;
  const startHunk = () => {
    if (!file) return;
    hunk = [];
    file.hunks.push(hunk);
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (header) {
      const kind = header[1];
      file = { path: header[2]!.trim(), st: kind === 'Add' ? 'A' : kind === 'Delete' ? 'D' : 'M', add: 0, del: 0, hunks: [] };
      files.push(file);
      hunk = null;
      if (file.st === 'A') startHunk();
      continue;
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move && file) {
      file.moveTo = move[1]!.trim();
      continue;
    }
    if (line.startsWith('***')) continue; // Begin/End Patch, End of File
    if (!file) continue;
    if (line.startsWith('@@')) {
      startHunk();
      continue;
    }
    const kind = line[0];
    if (kind !== '+' && kind !== '-' && kind !== ' ') continue;
    if (!hunk) startHunk();
    (hunk as string[] | null)?.push(clean(line));
    if (kind === '+') file.add++;
    else if (kind === '-') file.del++;
  }
  return files;
}
