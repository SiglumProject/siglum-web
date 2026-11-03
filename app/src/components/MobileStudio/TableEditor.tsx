import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'

/** A single, stationary input keeps the phone keyboard from chasing grid cells. */
export default function TableEditor({ value, onChange, caption, onCaptionChange }: {
  value: string; onChange: (value: string) => void; caption: string; onCaptionChange: (value: string) => void
}) {
  const rows = value.split('\n').map(row => row.split('\t'))
  const columns = Math.max(...rows.map(row => row.length))
  const [active, setActive] = useState({ row: 0, column: 0 })
  const input = useRef<HTMLInputElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const row = Math.min(active.row, rows.length - 1)
  const column = Math.min(active.column, columns - 1)
  const index = row * columns + column
  const select = (next: number) => {
    setActive({ row: Math.floor(next / columns), column: next % columns })
    input.current?.focus({ preventScroll: true })
    requestAnimationFrame(() => input.current?.select())
  }
  useEffect(() => {
    const host = grid.current
    const cell = host?.querySelector<HTMLElement>(`[data-cell="${row}-${column}"]`)
    if (!host || !cell) return
    const box = cell.getBoundingClientRect()
    const area = host.getBoundingClientRect()
    // Scroll only the grid, never the sheet or the focused input.
    if (box.left < area.left + 28) host.scrollLeft += box.left - area.left - 28
    else if (box.right > area.right) host.scrollLeft += box.right - area.right
    if (box.top < area.top + 24) host.scrollTop += box.top - area.top - 24
    else if (box.bottom > area.bottom) host.scrollTop += box.bottom - area.bottom
  }, [row, column])
  const nextCell = () => select(Math.min(rows.length * columns - 1, index + 1))
  return <div className="table-editor">
    <div className="table-cell-editor">
      <label htmlFor="table-cell-value">{String.fromCharCode(65 + column)}{row + 1}</label>
      <input ref={input} id="table-cell-value" aria-label="Cell value" value={rows[row][column] || ''} autoComplete="off" enterKeyHint="next" onChange={event => {
        const copy = rows.map(cells => [...cells]); copy[row][column] = event.target.value.replace(/[\t\n]/g, ' '); onChange(copy.map(cells => cells.join('\t')).join('\n'))
      }} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); nextCell() } }} />
      <button aria-label="Previous cell" disabled={index === 0} onMouseDown={event => event.preventDefault()} onClick={() => select(index - 1)}><ChevronLeft size={19} /></button>
      <button aria-label="Next cell" disabled={index === rows.length * columns - 1} onMouseDown={event => event.preventDefault()} onClick={nextCell}><ChevronRight size={19} /></button>
    </div>
    <div className="mobile-table-grid" ref={grid} aria-label="Table cells">
      <table style={{ minWidth: columns * 96 + 28 }}><thead><tr><th aria-label="Row number" />{Array.from({ length: columns }, (_, c) => <th key={c} scope="col">{String.fromCharCode(65 + c)}</th>)}</tr></thead>
        <tbody>{rows.map((cells, r) => <tr key={r}><th scope="row">{r + 1}</th>{Array.from({ length: columns }, (_, c) => <td key={c}><button data-cell={`${r}-${c}`} aria-label={`Row ${r + 1}, column ${c + 1}`} aria-pressed={row === r && column === c} onMouseDown={event => event.preventDefault()} onClick={() => select(r * columns + c)}>{cells[c] || '\u00a0'}</button></td>)}</tr>)}</tbody>
      </table>
    </div>
    <div className="table-options">
      <div className="table-size-actions"><button aria-label="Add row" disabled={rows.length >= 8} onMouseDown={event => event.preventDefault()} onClick={() => onChange(value + '\n' + Array(columns).fill('').join('\t'))}><Plus size={15} />Row</button><button aria-label="Add column" disabled={columns >= 5} onMouseDown={event => event.preventDefault()} onClick={() => onChange(rows.map(cells => cells.join('\t') + '\t').join('\n'))}><Plus size={15} />Column</button><span>{rows.length} × {columns}</span></div>
      <details><summary>Caption</summary><input aria-label="Table caption" value={caption} onChange={event => onCaptionChange(event.target.value)} placeholder="Optional caption" /></details>
    </div>
  </div>
}
