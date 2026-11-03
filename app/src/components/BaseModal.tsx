import React, { useState, useEffect, useCallback, useRef } from 'react';
import './BaseModal.css';
import { X } from 'lucide-react';

interface BaseModalProps {
  isOpen: boolean;
  isClosing?: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  maxWidth?: string;
  className?: string;
  overlayClassName?: string;
  headerContent?: React.ReactNode; // Custom content to place before the title
  hideHeader?: boolean; // Hide the default header
}

const BaseModal: React.FC<BaseModalProps> = ({
  isOpen,
  isClosing = false,
  onClose,
  title,
  children,
  maxWidth = '800px',
  className = '',
  overlayClassName = '',
  headerContent,
  hideHeader = false
}) => {
  const [internalClosing, setInternalClosing] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);

  // Handle close with animation
  const handleClose = useCallback(() => {
    setInternalClosing(true);
    setTimeout(() => {
      setInternalClosing(false);
      onClose();
    }, 200); // Match CSS animation duration
  }, [onClose]);

  // Reset when opening
  useEffect(() => {
    if (isOpen) {
      setInternalClosing(false);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select, textarea, summary, [tabindex="0"]'
    ) ?? []).filter(element => element.getClientRects().length > 0);
    (focusable()[0] ?? dialog)?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0] ?? dialog;
      const last = items[items.length - 1] ?? dialog;
      if (!dialog?.contains(document.activeElement) ||
          (event.shiftKey && document.activeElement === first) ||
          (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      document.removeEventListener('keydown', trapFocus);
      if (previous?.isConnected) previous.focus();
    };
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose]);

  if (!isOpen) return null;

  const isCurrentlyClosing = isClosing || internalClosing;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  return (
    <div 
      className={`base-modal-overlay ${overlayClassName} ${isCurrentlyClosing ? 'closing' : ''}`} 
      onClick={handleOverlayClick}
    >
      <div 
        className={`base-modal ${className}`}
        style={{ maxWidth }}
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {!hideHeader && (
          <div className="base-modal-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              {headerContent}
              <h2>{title}</h2>
            </div>
            <button className="base-modal-close-button" aria-label="Close dialog" onClick={handleClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="base-modal-content">
          {children}
        </div>
      </div>
    </div>
  );
};

export default BaseModal;