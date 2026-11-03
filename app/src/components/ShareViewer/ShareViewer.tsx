/**
 * ShareViewer - Beautiful, functional feedback viewer
 *
 * Renders actual PDFs using pdf.js and allows reviewers to
 * leave positioned comments on the document.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronLeft, ChevronRight, Send, User, ZoomIn, ZoomOut, X, MessageCircle, Pencil, Trash2 } from 'lucide-react'
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs'
import ShareService, { type Comment, type Share } from '../../services/ShareService'
import GitService from '../../services/GitService'
import StateStore from '../../services/FileStateStore'
import './ShareViewer.css'

// Set worker path
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
  import.meta.url
).toString()

// Generate a new session token
function generateSessionToken(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36)
}

interface ShareViewerProps {
  shareId: string
  onClose?: () => void
}

const ShareViewer: React.FC<ShareViewerProps> = ({ shareId, onClose }) => {
  // Share data
  const [share, setShare] = useState<Share | null>(null)
  const [error, setError] = useState<string | null>(null)

  // PDF state
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [pageCount, setPageCount] = useState(0)
  const [scale, setScale] = useState(1.2)
  const [isLoading, setIsLoading] = useState(true)

  // Comments state
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null)
  const [newCommentText, setNewCommentText] = useState('')
  const [pendingCommentPosition, setPendingCommentPosition] = useState<{ x: number; y: number; page: number } | null>(null)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editingText, setEditingText] = useState('')

  // User state
  const [userName, setUserName] = useState<string | null>(null)
  const [nameInput, setNameInput] = useState('')
  const [showNamePrompt, setShowNamePrompt] = useState(false)
  const [sessionToken, setSessionToken] = useState<string | null>(null)

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null)
  const commentsListRef = useRef<HTMLDivElement>(null)

  // Load session token and user name from StateStore
  useEffect(() => {
    const loadSessionData = async () => {
      // Load or create session token
      let token = await StateStore.getSessionToken()
      if (!token) {
        token = generateSessionToken()
        StateStore.setSessionToken(token)
      }
      setSessionToken(token)

      // Check if user is authenticated via GitHub
      const gitConfig = GitService.getConfig()
      if (gitConfig?.provider === 'github' && gitConfig.token) {
        // Try to fetch real name from GitHub API using token
        try {
          const response = await fetch('https://api.github.com/user', {
            headers: {
              Authorization: `Bearer ${gitConfig.token}`,
              Accept: 'application/vnd.github+json'
            }
          })
          if (response.ok) {
            const userData = await response.json()
            // Use name if available, otherwise fall back to login (username)
            const displayName = userData.name || userData.login
            if (displayName) {
              setUserName(displayName)
              return
            }
          }
        } catch (err) {
          // Fall through to other methods if API call fails
          console.warn('[ShareViewer] Could not fetch GitHub user info:', err)
        }

        // Try username from config
        if (gitConfig.username) {
          setUserName(gitConfig.username)
          return
        }

        // Try to extract username from repo URL (e.g., "adam-weber/resume" -> "adam-weber")
        if (gitConfig.repoUrl) {
          const match = gitConfig.repoUrl.match(/(?:github\.com\/)?([^\/]+)\//)
          if (match && match[1]) {
            setUserName(match[1])
            return
          }
        }
      }

      // Fall back to StateStore
      const stored = await StateStore.getReviewerName()
      if (stored) {
        setUserName(stored)
      } else {
        setShowNamePrompt(true)
      }
    }

    loadSessionData()
  }, [])

  // Load share data
  useEffect(() => {
    let cancelled = false

    const loadShare = async () => {
      await ShareService.initialize()
      if (cancelled) return
      const loadedShare = ShareService.getShare(shareId)
      if (!loadedShare) {
        setError('Share not found')
        setIsLoading(false)
        return
      }
      setShare(loadedShare)
    }
    loadShare()

    return () => {
      cancelled = true
    }
  }, [shareId])

  // Load PDF when share is loaded
  useEffect(() => {
    if (!share) return

    let cancelled = false
    let loadedPdf: pdfjsLib.PDFDocumentProxy | null = null

    const loadPdf = async () => {
      try {
        setIsLoading(true)
        const pdfData = await ShareService.getPdfData(shareId)
        if (cancelled) return
        if (!pdfData) {
          setError('PDF data not found')
          return
        }

        const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfData) })
        const pdfDoc = await loadingTask.promise
        if (cancelled) {
          pdfDoc.destroy()
          return
        }
        loadedPdf = pdfDoc
        setPdf(pdfDoc)
        setPageCount(pdfDoc.numPages)
        setIsLoading(false)
      } catch (err) {
        if (cancelled) return
        console.error('Failed to load PDF:', err)
        setError('Failed to load PDF')
        setIsLoading(false)
      }
    }

    loadPdf()

    return () => {
      cancelled = true
      // Clear state before destroying to prevent render with destroyed PDF
      setPdf(null)
      if (loadedPdf) {
        loadedPdf.destroy()
      }
    }
  }, [share, shareId])

  // Render current page
  useEffect(() => {
    if (!pdf || !canvasRef.current) return

    const renderPage = async () => {
      // Cancel any ongoing render
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
      }

      try {
        const page = await pdf.getPage(currentPage)
        const viewport = page.getViewport({ scale })
        const canvas = canvasRef.current!
        const context = canvas.getContext('2d')!

        // Set canvas dimensions
        const pixelRatio = window.devicePixelRatio || 1
        canvas.width = viewport.width * pixelRatio
        canvas.height = viewport.height * pixelRatio
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        context.scale(pixelRatio, pixelRatio)

        // Render
        renderTaskRef.current = page.render({
          canvasContext: context,
          viewport,
          canvas
        })

        await renderTaskRef.current.promise
        page.cleanup()
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
          console.error('Render error:', err)
        }
      }
    }

    renderPage()

    return () => {
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel()
      }
    }
  }, [pdf, currentPage, scale])

  // Handle canvas click for adding comments
  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !userName) {
      if (!userName) setShowNamePrompt(true)
      return
    }

    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height

    setPendingCommentPosition({ x, y, page: currentPage })
    setNewCommentText('')
    setEditingCommentId(null)
  }, [currentPage, userName])

  // Submit comment
  const handleSubmitComment = useCallback(async () => {
    if (!pendingCommentPosition || !newCommentText.trim() || !userName || !sessionToken) return

    const comment = await ShareService.addComment(shareId, {
      page: pendingCommentPosition.page,
      x: pendingCommentPosition.x,
      y: pendingCommentPosition.y,
      text: newCommentText.trim(),
      author: userName,
      sessionToken
    })

    if (comment) {
      // Refresh share data
      const updated = ShareService.getShare(shareId)
      if (updated) setShare(updated)
      setSelectedCommentId(comment.id)
    }

    setPendingCommentPosition(null)
    setNewCommentText('')
  }, [shareId, pendingCommentPosition, newCommentText, userName, sessionToken])

  // Cancel pending comment
  const handleCancelComment = useCallback(() => {
    setPendingCommentPosition(null)
    setNewCommentText('')
  }, [])

  // Start editing a comment
  const handleStartEdit = useCallback((comment: Comment) => {
    setEditingCommentId(comment.id)
    setEditingText(comment.text)
    setPendingCommentPosition(null)
  }, [])

  // Save edited comment
  const handleSaveEdit = useCallback(async () => {
    if (!editingCommentId || !editingText.trim() || !sessionToken) return

    const success = await ShareService.updateComment(shareId, editingCommentId, editingText.trim(), sessionToken)
    if (success) {
      const updated = ShareService.getShare(shareId)
      if (updated) setShare(updated)
    }

    setEditingCommentId(null)
    setEditingText('')
  }, [shareId, editingCommentId, editingText, sessionToken])

  // Cancel editing
  const handleCancelEdit = useCallback(() => {
    setEditingCommentId(null)
    setEditingText('')
  }, [])

  // Delete comment
  const handleDeleteComment = useCallback(async (commentId: string) => {
    if (!sessionToken) return
    const success = await ShareService.deleteComment(shareId, commentId, sessionToken)
    if (success) {
      const updated = ShareService.getShare(shareId)
      if (updated) setShare(updated)
      if (selectedCommentId === commentId) {
        setSelectedCommentId(null)
      }
    }
  }, [shareId, sessionToken, selectedCommentId])

  // Submit name
  const handleNameSubmit = useCallback(() => {
    const name = nameInput.trim()
    if (name) {
      StateStore.setReviewerName(name)
      setUserName(name)
      setShowNamePrompt(false)
    }
  }, [nameInput])

  // Select comment and scroll to it
  const handleSelectComment = useCallback((comment: Comment) => {
    setSelectedCommentId(comment.id)
    if (comment.page !== currentPage) {
      setCurrentPage(comment.page)
    }
  }, [currentPage])

  // Check if user owns a comment
  const isOwnComment = useCallback((comment: Comment) => {
    return sessionToken !== null && comment.sessionToken === sessionToken
  }, [sessionToken])

  // Format timestamp
  const formatTime = (date: Date) => {
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / (1000 * 60))
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays === 1) return 'yesterday'
    return `${diffDays}d ago`
  }

  // Get initials from name
  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  // Get comments for current page
  const pageComments = share?.comments.filter(c => c.page === currentPage) || []
  const allComments = share?.comments || []

  // Loading state
  if (isLoading) {
    return (
      <div className="share-viewer">
        <div className="share-viewer-loading">
          <div className="loading-spinner" />
          <p>Loading document...</p>
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="share-viewer">
        <div className="share-viewer-error">
          <h2>Unable to load</h2>
          <p>{error}</p>
          {onClose && (
            <button className="error-close-btn" onClick={onClose}>
              Go back
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="share-viewer">
      {/* Name prompt */}
      {showNamePrompt && (
        <div className="prompt-overlay" onClick={() => userName && setShowNamePrompt(false)}>
          <div className="prompt" onClick={e => e.stopPropagation()}>
            <div className="prompt-body">
              <div className="prompt-icon">
                <User size={24} />
              </div>
              <h2>What's your name?</h2>
              <p>Your name will appear with your feedback.</p>
              <input
                type="text"
                className="prompt-input"
                placeholder="Enter your name"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleNameSubmit()}
                autoFocus
              />
            </div>
            <div className="prompt-footer">
              <button
                className="prompt-btn"
                onClick={handleNameSubmit}
                disabled={!nameInput.trim()}
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="share-header">
        <div className="share-header-left">
          {onClose && (
            <button className="header-btn" onClick={onClose} title="Close">
              <X size={14} />
            </button>
          )}
          <div className="share-title">
            <h1>{share?.name || 'Document'}</h1>
            <span className="share-subtitle">Shared for feedback</span>
          </div>
        </div>
        <div className="share-header-center">
          <button
            className="header-btn"
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            title="Previous page"
          >
            <ChevronLeft size={14} />
          </button>
          <span className="page-indicator">{currentPage} / {pageCount}</span>
          <button
            className="header-btn"
            onClick={() => setCurrentPage(p => Math.min(pageCount, p + 1))}
            disabled={currentPage === pageCount}
            title="Next page"
          >
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="share-header-right">
          <button
            className="header-btn"
            onClick={() => setScale(s => Math.max(0.5, s - 0.2))}
            disabled={scale <= 0.5}
            title="Zoom out"
          >
            <ZoomOut size={14} />
          </button>
          <span className="zoom-indicator">{Math.round(scale * 100)}%</span>
          <button
            className="header-btn"
            onClick={() => setScale(s => Math.min(2, s + 0.2))}
            disabled={scale >= 2}
            title="Zoom in"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="share-main">
        {/* PDF area */}
        <div className="share-pdf-area" ref={containerRef}>
          <div className="pdf-scroll-container">
            <div className="pdf-page-wrapper">
              <canvas
                ref={canvasRef}
                className="pdf-canvas"
                onClick={handleCanvasClick}
              />

              {/* Comment markers on current page */}
              {pageComments.map(comment => (
                <button
                  key={comment.id}
                  className={`comment-marker ${selectedCommentId === comment.id ? 'active' : ''}`}
                  style={{
                    left: `${comment.x * 100}%`,
                    top: `${comment.y * 100}%`
                  }}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleSelectComment(comment)
                  }}
                  title={comment.text}
                >
                  <MessageCircle size={12} />
                </button>
              ))}

              {/* Pending comment marker */}
              {pendingCommentPosition && pendingCommentPosition.page === currentPage && (
                <div
                  className="comment-marker pending"
                  style={{
                    left: `${pendingCommentPosition.x * 100}%`,
                    top: `${pendingCommentPosition.y * 100}%`
                  }}
                >
                  <MessageCircle size={12} />
                </div>
              )}
            </div>
          </div>

          {/* Click hint */}
          {!pendingCommentPosition && (
            <div className="click-hint">
              Click anywhere to add feedback
            </div>
          )}
        </div>

        {/* Feedback panel */}
        <aside className="share-panel">
          <div className="panel-header">
            <h2>Feedback</h2>
            <span className="comment-count">{allComments.length}</span>
          </div>

          {/* Pending comment input */}
          {pendingCommentPosition && (
            <div className="pending-comment">
              <div className="pending-comment-header">
                <span>Page {pendingCommentPosition.page}</span>
                <button className="cancel-btn" onClick={handleCancelComment}>
                  <X size={14} />
                </button>
              </div>
              <textarea
                className="comment-textarea"
                placeholder="Write your feedback..."
                value={newCommentText}
                onChange={(e) => setNewCommentText(e.target.value)}
                autoFocus
                rows={3}
              />
              <button
                className="submit-comment-btn"
                onClick={handleSubmitComment}
                disabled={!newCommentText.trim()}
              >
                <Send size={12} />
                <span>Send</span>
              </button>
            </div>
          )}

          {/* Comments list */}
          <div className="comments-scroll" ref={commentsListRef}>
            {allComments.length === 0 && !pendingCommentPosition ? (
              <div className="no-comments">
                <MessageCircle size={28} />
                <p>No feedback yet</p>
                <span>Click on the document to add a comment</span>
              </div>
            ) : (
              allComments.map(comment => (
                <div
                  key={comment.id}
                  className={`comment-card ${selectedCommentId === comment.id ? 'active' : ''}`}
                  onClick={() => handleSelectComment(comment)}
                >
                  <div className="comment-card-header">
                    <div className="comment-avatar">
                      {getInitials(comment.author || 'A')}
                    </div>
                    <div className="comment-meta">
                      <span className="comment-author">{comment.author || 'Anonymous'}</span>
                      <span className="comment-time">{formatTime(comment.createdAt)}</span>
                    </div>
                    {isOwnComment(comment) && editingCommentId !== comment.id && (
                      <div className="comment-actions">
                        <button
                          className="comment-action-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleStartEdit(comment)
                          }}
                          title="Edit"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="comment-action-btn delete"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDeleteComment(comment.id)
                          }}
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                  {editingCommentId === comment.id ? (
                    <div className="comment-edit">
                      <textarea
                        className="comment-textarea"
                        value={editingText}
                        onChange={(e) => setEditingText(e.target.value)}
                        autoFocus
                        rows={2}
                        onClick={(e) => e.stopPropagation()}
                      />
                      <div className="comment-edit-actions">
                        <button className="edit-cancel-btn" onClick={handleCancelEdit}>
                          Cancel
                        </button>
                        <button
                          className="edit-save-btn"
                          onClick={handleSaveEdit}
                          disabled={!editingText.trim()}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p className="comment-text">{comment.text}</p>
                      <span className="comment-page">Page {comment.page}</span>
                    </>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Quick input hint */}
          {!pendingCommentPosition && userName && (
            <div className="quick-input">
              <div className="quick-input-avatar">
                {getInitials(userName)}
              </div>
              <input
                type="text"
                placeholder="Click document to add..."
                readOnly
                onClick={() => containerRef.current?.scrollIntoView({ behavior: 'smooth' })}
              />
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

export default ShareViewer
