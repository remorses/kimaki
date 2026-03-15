// Shared apply_patch text parsing utilities.
// Used by diff-patch-plugin.ts (file path extraction for snapshots) and
// message-formatting.ts (per-file addition/deletion counts for Discord display).
//
// The apply_patch tool uses three path header formats:
//   *** Add File: path    — new file
//   *** Update File: path — existing file edit
//   *** Delete File: path — file removal
//   *** Move to: path     — rename destination
//   --- a/path / +++ b/path — unified diff headers (fallback)

/**
 * Extract all file paths referenced in a patchText string.
 * Handles custom apply_patch headers, move targets, and unified diff headers.
 * Returns deduplicated paths.
 */
export function extractPatchFilePaths(patchText: string): string[] {
  const custom = [
    ...patchText.matchAll(
      /^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/gm,
    ),
  ].map((m) => {
    return (m[1] ?? '').trim()
  })
  const moved = [
    ...patchText.matchAll(/^\*\*\* Move to:\s+(.+)$/gm),
  ].map((m) => {
    return (m[1] ?? '').trim()
  })
  const unified = [
    ...patchText.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gm),
  ].map((m) => {
    return (m[1] ?? '').trim()
  })
  const all = [...custom, ...moved, ...unified].filter(Boolean)
  return all.filter((v, i, a) => {
    return a.indexOf(v) === i
  })
}

/**
 * Parse a patchText string and count additions/deletions per file.
 * Patch format uses `*** Add File:`, `*** Update File:`, `*** Delete File:` headers,
 * with diff lines prefixed by `+` (addition) or `-` (deletion) inside `@@` hunks.
 */
export function parsePatchFileCounts(
  patchText: string,
): Map<string, { additions: number; deletions: number }> {
  const counts = new Map<string, { additions: number; deletions: number }>()
  const lines = patchText.split('\n')
  let currentFile = ''
  let currentType = ''
  let inHunk = false

  for (const line of lines) {
    const addMatch = line.match(/^\*\*\* Add File:\s*(.+)/)
    const updateMatch = line.match(/^\*\*\* Update File:\s*(.+)/)
    const deleteMatch = line.match(/^\*\*\* Delete File:\s*(.+)/)

    if (addMatch || updateMatch || deleteMatch) {
      const match = addMatch || updateMatch || deleteMatch
      currentFile = (match?.[1] ?? '').trim()
      currentType = addMatch ? 'add' : updateMatch ? 'update' : 'delete'
      counts.set(currentFile, { additions: 0, deletions: 0 })
      inHunk = false
      continue
    }

    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }

    if (line.startsWith('*** ')) {
      inHunk = false
      continue
    }

    if (!currentFile) {
      continue
    }

    const entry = counts.get(currentFile)
    if (!entry) {
      continue
    }

    if (currentType === 'add') {
      // all content lines in Add File are additions
      if (line.length > 0 && !line.startsWith('*** ')) {
        entry.additions++
      }
    } else if (currentType === 'delete') {
      // all content lines in Delete File are deletions
      if (line.length > 0 && !line.startsWith('*** ')) {
        entry.deletions++
      }
    } else if (inHunk) {
      if (line.startsWith('+')) {
        entry.additions++
      } else if (line.startsWith('-')) {
        entry.deletions++
      }
    }
  }
  return counts
}
