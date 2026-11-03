import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Copy } from 'lucide-react'
import './SelectionContextMenu.css'

interface Props {
  x: number
  y: number
  canJump: boolean
  onJump: () => void
  onCopy: () => void
  onClose: (restoreFocus: boolean) => void
}

export default function SelectionContextMenu({ x, y, canJump, onJump, onCopy, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  useLayoutEffect(() => {
    const menu = ref.current!
    const rect = menu.getBoundingClientRect()
    setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) })
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [x, y])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) onClose(false) }
    const dismiss = () => onClose(false)
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('wheel', dismiss, { passive: true })
    return () => { window.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', dismiss); window.removeEventListener('wheel', dismiss) }
  }, [onClose])
  return createPortal(<div ref={ref} className="selection-context-menu" role="menu" aria-label="Selection actions" style={position}
    onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(true) }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault()
        const buttons = Array.from(ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
        buttons[next]?.focus()
      }
    }}>
    <button role="menuitem" disabled={!canJump} title={canJump ? undefined : 'Compile the document first'} onClick={onJump}><ArrowUpRight size={16} aria-hidden="true" />Jump to PDF</button>
    <div className="selection-menu-divider" role="separator" />
    <button role="menuitem" onClick={onCopy}><Copy size={15} aria-hidden="true" />Copy</button>
  </div>, document.body)
}
