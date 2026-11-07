export interface ConflictLine {
  kind: 'same' | 'local' | 'remote'
  text: string
  local?: number
  remote?: number
}

export function conflictLines(local: string | null, remote: string | null): ConflictLine[] {
  const left = local ? local.split('\n') : []
  const right = remote ? remote.split('\n') : []
  const rows: ConflictLine[] = []
  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) {
    rows.push({ kind: 'same', text: left[start], local: start + 1, remote: start + 1 })
    start++
  }
  let endLeft = left.length
  let endRight = right.length
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft--
    endRight--
  }

  // Align typical edits by line. Bound memory for wholesale file replacements.
  const width = endRight - start + 1
  const cells = (endLeft - start + 1) * width
  const lcs = cells <= 1_000_000 ? new Uint32Array(cells) : null
  if (lcs) {
    for (let a = endLeft - 1; a >= start; a--) {
      for (let b = endRight - 1; b >= start; b--) {
        const i = (a - start) * width + b - start
        lcs[i] = left[a] === right[b] ? lcs[i + width + 1] + 1 : Math.max(lcs[i + 1], lcs[i + width])
      }
    }
  }
  let a = start
  let b = start
  while (a < endLeft || b < endRight) {
    const i = (a - start) * width + b - start
    if (lcs && a < endLeft && b < endRight && left[a] === right[b]) {
      rows.push({ kind: 'same', text: left[a++], local: a, remote: ++b })
    } else if (a < endLeft && (b === endRight || !lcs || lcs[i + width] >= lcs[i + 1])) {
      rows.push({ kind: 'local', text: left[a++], local: a })
    } else {
      rows.push({ kind: 'remote', text: right[b++], remote: b })
    }
  }
  while (endLeft < left.length) {
    rows.push({ kind: 'same', text: left[endLeft++], local: endLeft, remote: ++endRight })
  }
  return rows
}

export function collapseUnchangedLines(rows: ConflictLine[]): (ConflictLine | number)[] {
  const visible: (ConflictLine | number)[] = []
  let i = 0
  while (i < rows.length) {
    if (rows[i].kind !== 'same') {
      visible.push(rows[i++])
      continue
    }
    let end = i + 1
    while (end < rows.length && rows[end].kind === 'same') end++
    if (end - i > 8) {
      visible.push(...rows.slice(i, i + 3), end - i - 6, ...rows.slice(end - 3, end))
    } else {
      visible.push(...rows.slice(i, end))
    }
    i = end
  }
  return visible
}
