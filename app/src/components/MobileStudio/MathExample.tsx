import { useEffect, useRef, useState } from 'react'
import katex from 'katex'
import 'katex/dist/katex.min.css'

export default function MathExample({ source }: { source: string }) {
  const target = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!target.current) return
    try {
      katex.render(source.replace(/^\\\[|\\\]$/g, '').trim(), target.current, {
        displayMode: true, throwOnError: true, trust: false, maxExpand: 200, maxSize: 20,
      })
      setError('')
    } catch {
      target.current.textContent = ''
      setError('This expression needs your document’s compiler. You can still insert and edit it.')
    }
  }, [source])
  return <><div ref={target} />{error && <span className="mobile-math-message" role="status">{error}</span>}</>
}
