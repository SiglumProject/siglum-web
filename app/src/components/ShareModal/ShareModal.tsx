import React, { useState, useEffect } from 'react'
import { X, Copy, Check, MessageSquare, ExternalLink, Plus } from 'lucide-react'
import ShareService, { type Share } from '../../services/ShareService'
import './ShareModal.css'

interface ShareModalProps {
  isOpen: boolean
  isClosing?: boolean
  onClose: () => void
  onCreateShare: () => Promise<string | null> // Returns share ID if created
  onViewShare: (shareId: string) => void
}

const ShareModal: React.FC<ShareModalProps> = ({
  isOpen,
  isClosing,
  onClose,
  onCreateShare,
  onViewShare
}) => {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [shares, setShares] = useState<Share[]>([])

  // Initialize and load shares from service
  useEffect(() => {
    if (isOpen) {
      ShareService.initialize().then(() => {
        setShares(ShareService.getShares())
      })
    }
  }, [isOpen])

  // Subscribe to share status changes
  useEffect(() => {
    const unsubscribe = ShareService.subscribe(() => {
      setShares(ShareService.getShares())
    })
    return unsubscribe
  }, [])

  if (!isOpen) return null

  const formatDate = (date: Date) => {
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffHours < 1) return 'Just now'
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays} days ago`
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  const handleCopyLink = (shareId: string) => {
    const url = ShareService.getShareUrl(shareId)
    navigator.clipboard.writeText(url)
    setCopiedId(shareId)
    setTimeout(() => setCopiedId(null), 2000)
  }

  const getNewComments = (share: Share) => {
    return Math.max(0, share.comments.length - share.lastSeenCommentCount)
  }

  return (
    <div className={`share-modal-overlay ${isClosing ? 'closing' : ''}`} onClick={onClose}>
      <div className="share-modal" onClick={e => e.stopPropagation()}>
        <div className="share-modal-header">
          <h2>Share for Feedback</h2>
          <button className="share-modal-close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="share-modal-content">
          {/* Create new share */}
          <button
            className={`share-create-btn ${copiedId === 'new' ? 'copied' : ''}`}
            onClick={async () => {
              const shareId = await onCreateShare()
              if (shareId) {
                setCopiedId('new')
                setTimeout(() => setCopiedId(null), 2000)
              }
            }}
          >
            {copiedId === 'new' ? <Check size={16} /> : <Plus size={16} />}
            <span>{copiedId === 'new' ? 'Link copied!' : 'Create new share'}</span>
          </button>
          <p className="share-create-hint">
            Creates a snapshot of your current PDF. Anyone with the link can comment.
          </p>

          {/* Previous shares */}
          {shares.length > 0 && (
            <div className="share-list">
              <h3>Previous shares</h3>
              {shares.map((share, index) => {
                const newComments = getNewComments(share)
                // Version number: newest is highest (shares are sorted newest first)
                const version = shares.length - index
                return (
                  <div key={share.id} className="share-item">
                    <div className="share-item-main" onClick={() => onViewShare(share.id)}>
                      <div className="share-item-info">
                        <span className="share-item-name">
                          <span className="share-item-version">v{version}</span>
                          {share.name}
                        </span>
                        <span className="share-item-date">{formatDate(share.createdAt)}</span>
                      </div>
                      <div className="share-item-comments">
                        <MessageSquare size={14} />
                        <span>{share.comments.length}</span>
                        {newComments > 0 && (
                          <span className="share-item-new">+{newComments}</span>
                        )}
                      </div>
                    </div>
                    <div className="share-item-actions">
                      <button
                        className="share-item-copy"
                        onClick={() => handleCopyLink(share.id)}
                        title="Copy link"
                      >
                        {copiedId === share.id ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                      <button
                        className="share-item-open"
                        onClick={() => onViewShare(share.id)}
                        title="View"
                      >
                        <ExternalLink size={14} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default ShareModal
