import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, FileText, X } from 'lucide-react'
import type { GitConflictResolution, GitConflictReview } from '@siglum/git'
import { collapseUnchangedLines, conflictLines } from './conflictDiff'
import './GitConflictModal.css'

export interface GitConflictModalProps {
  repoUrl?: string
  loadReview: () => Promise<GitConflictReview>
  onApply: (reviewId: string, resolutions: GitConflictResolution[]) => Promise<void>
  onClose: () => void
  busy?: boolean
}

function githubRepo(repoUrl?: string) {
  if (!repoUrl) return
  try {
    const url = new URL(repoUrl)
    const path = url.pathname.replace(/\.git\/?$/, '').replace(/\/$/, '')
    if (url.protocol === 'https:' && url.host === 'github.com' && /^\/[\w.-]+\/[\w.-]+$/.test(path)) {
      return { name: path.slice(1), url: 'https://github.com' + path }
    }
  } catch {
    // The review itself also works for repositories without a GitHub URL.
  }
}

export default function GitConflictModal({ repoUrl, loadReview, onApply, onClose, busy = false }: GitConflictModalProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const title = useId()
  const [review, setReview] = useState<GitConflictReview>()
  const [activePath, setActivePath] = useState('')
  const [choices, setChoices] = useState(() => new Map<string, GitConflictResolution>())
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const saving = useRef(false)
  const request = useRef<{ attempt: number; promise: Promise<GitConflictReview> }>()
  const repo = githubRepo(repoUrl)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  useEffect(() => {
    if (review) return
    let current = true
    setLoading(true)
    setError('')
    if (request.current?.attempt !== attempt) request.current = { attempt, promise: loadReview() }
    void request.current.promise.then(result => {
      if (!current) return
      setReview(result)
      setActivePath(result.files[0]?.path ?? '')
      setChoices(new Map())
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : 'Could not load the conflict.')
    }).finally(() => {
      if (current) setLoading(false)
    })
    return () => { current = false }
  }, [attempt, loadReview, review])

  const file = review?.files.find(item => item.path === activePath)
  const choice = file ? choices.get(file.path) : undefined
  const rows = useMemo(() => file && !file.isBinary
    ? collapseUnchangedLines(conflictLines(file.localText, file.remoteText))
    : [], [file])
  const ready = !!review?.files.length && review.files.every(item => choices.get(item.path))
  const commitUrl = repo && review && /^[a-f0-9]{40}$/i.test(review.remoteHead)
    ? `${repo.url}/commit/${review.remoteHead}` : undefined

  function pick(resolution: GitConflictResolution) {
    setChoices(previous => new Map(previous).set(resolution.path, resolution))
  }

  async function apply() {
    if (!review || !ready || saving.current || busy) return
    saving.current = true
    setApplying(true)
    setError('')
    try {
      await onApply(review.id, review.files.flatMap(item => {
        const selected = choices.get(item.path)
        return selected ? [selected] : []
      }))
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not apply the resolution.')
    } finally {
      saving.current = false
      setApplying(false)
    }
  }

  function dismiss() {
    if (!saving.current) onClose()
  }

  return (
    <dialog ref={dialog} className="git-conflict-dialog" aria-labelledby={title} onCancel={event => {
      event.preventDefault()
      dismiss()
    }}>
      <header className="git-conflict-header">
        <div className="git-conflict-title-row">
          <h2 id={title}>Conflicting changes</h2>
          <button type="button" aria-label="Close conflict review" onClick={dismiss} disabled={applying}><X size={19} aria-hidden="true" /></button>
        </div>
        {(repo || review) && <div className="git-conflict-meta">
          <p>{repo?.name}{repo && review ? ' · ' : ''}{review?.branch}</p>
          {commitUrl && <a href={commitUrl} target="_blank" rel="noopener noreferrer">GitHub commit <ArrowUpRight size={14} aria-hidden="true" /></a>}
        </div>}
      </header>
      <div className="git-conflict-body">
        {error && <p className="git-conflict-error" role="alert">{error}</p>}
        {(loading || busy) && !review && <p role="status">Loading both versions…</p>}
        {!review && !loading && !busy && <button type="button" onClick={() => setAttempt(attempt + 1)}>Retry review</button>}
        {review && !file && <p>There are no files left to review.</p>}
        {file && (
          <>
            {review && review.files.length > 1 && (
              <label className="git-conflict-picker">
                File to review
                <select value={activePath} onChange={event => setActivePath(event.target.value)} disabled={applying}>
                  {review.files.map(item => <option key={item.path} value={item.path}>{item.path}{choices.get(item.path) ? ' (reviewed)' : ''}</option>)}
                </select>
              </label>
            )}
            <section className="git-conflict-file" aria-label={`Review ${file.path}`}>
              <div className="git-conflict-file-title"><FileText size={16} aria-hidden="true" /><code>{file.path}</code></div>
              <div className="git-conflict-legend">
                <span className="git-conflict-local">− On this device</span>
                <span className="git-conflict-remote">+ On GitHub</span>
              </div>
              {(!file.localExists || !file.remoteExists) && (
                <p className="git-conflict-note">{file.localExists ? 'GitHub deleted this file.' : 'This file is absent on this device.'}</p>
              )}
              {file.isBinary ? <p className="git-conflict-note">Choose which file to keep.</p> : (
                <div className="git-conflict-diff" tabIndex={0} role="region" aria-label="Highlighted line changes">
                  {rows.length ? rows.map((line, index) => typeof line === 'number' ? (
                    <div className="git-conflict-fold" key={index}>{line} unchanged lines</div>
                  ) : (
                    <div className={`git-conflict-line git-conflict-${line.kind}`} key={index}>
                      <span aria-hidden="true">{line.local}</span><span aria-hidden="true">{line.remote}</span>
                      <span aria-label={line.kind === 'local' ? 'On this device' : line.kind === 'remote' ? 'On GitHub' : undefined}>
                        {line.kind === 'local' ? '−' : line.kind === 'remote' ? '+' : ' '}
                      </span>
                      <code>{line.text || ' '}</code>
                    </div>
                  )) : <p className="git-conflict-note">The text is identical.</p>}
                </div>
              )}
              <fieldset className="git-conflict-options" disabled={applying || busy}>
                <legend>Result for this file</legend>
                <button type="button" aria-pressed={choice?.choice === 'local'} onClick={() => pick({ path: file.path, choice: 'local' })}>Keep local</button>
                <button type="button" aria-pressed={choice?.choice === 'remote'} onClick={() => pick({ path: file.path, choice: 'remote' })}>Use GitHub</button>
                {!file.isBinary && <button type="button" aria-pressed={choice?.choice === 'merged'} onClick={() => {
                  if (choice?.choice !== 'merged') pick({ path: file.path, choice: 'merged', content: (choice?.choice === 'remote' ? file.remoteText : file.localText) ?? file.remoteText ?? '' })
                }}>Edit result</button>}
              </fieldset>
              {choice?.choice === 'merged' && (
                <label className="git-conflict-merge">Merged file
                  <textarea value={choice.content} spellCheck={false} disabled={applying || busy}
                    onChange={event => pick({ ...choice, content: event.target.value })} />
                </label>
              )}
            </section>
          </>
        )}
      </div>
      <footer className="git-conflict-footer">
        {review && <span aria-live="polite">{choices.size} of {review.files.length} files reviewed</span>}
        <div className="git-conflict-footer-actions">
          {error && review && <button type="button" disabled={applying} onClick={() => {
            setReview(undefined)
            setAttempt(attempt + 1)
          }}>Reload review</button>}
          <button type="button" onClick={dismiss} disabled={applying}>Decide later</button>
          <button className="git-conflict-apply" type="button" onClick={() => void apply()} disabled={!ready || applying || busy}>
            {applying ? 'Applying…' : 'Apply locally'}
          </button>
        </div>
      </footer>
    </dialog>
  )
}
