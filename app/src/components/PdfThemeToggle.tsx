import { Sun } from 'lucide-react'
import { usePdfTheme } from '../hooks/usePdfTheme'

export default function PdfThemeToggle({ className, size = 14 }: { className?: string; size?: number }) {
  const { dark, toggle } = usePdfTheme()
  const label = dark ? 'Switch PDF to light mode' : 'Switch PDF to dark mode'
  return <button type="button" className={className} aria-label={label} title={label} onClick={toggle}>
    <Sun size={size} aria-hidden="true" />
  </button>
}
