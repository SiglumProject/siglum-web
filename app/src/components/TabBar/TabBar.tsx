import React, { useState, useEffect, useRef } from 'react'
import { X, FileText } from 'lucide-react'
import { fileManager } from '../../services/FileManager'
import './TabBar.css'

interface TabBarProps {
  currentPath: string | undefined
  onTabSelect: (path: string) => void
  onTabClose: (path: string) => void
  onTabsChanged?: (tabs: string[]) => void
}

export const TabBar: React.FC<TabBarProps> = ({ currentPath, onTabSelect, onTabClose, onTabsChanged }) => {
  const [tabs, setTabs] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)
  const stableOrderRef = useRef<string[]>([])

  useEffect(() => {
    const recents = fileManager.getRecentPaths()
      .filter(p => p.endsWith('.tex'))
      .slice(0, 8)

    // Merge into stable order: keep existing tabs in place, append new ones at the end
    const prev = stableOrderRef.current
    const recentSet = new Set(recents)
    const kept = prev.filter(p => recentSet.has(p))
    const keptSet = new Set(kept)
    const added = recents.filter(p => !keptSet.has(p))
    const next = [...kept, ...added]

    stableOrderRef.current = next
    setTabs(next)
    onTabsChanged?.(next)
  }, [currentPath, onTabsChanged])

  if (tabs.length < 2) return null

  return (
    <div className="tab-bar" ref={scrollRef}>
      {tabs.map(path => {
        const fileName = path.split('/').pop() || path
        const isActive = path === currentPath
        return (
          <div
            key={path}
            className={`tab-bar-tab${isActive ? ' active' : ''}`}
            onClick={() => onTabSelect(path)}
            title={path}
          >
            <FileText size={12} className="tab-icon" />
            <span className="tab-name">{fileName}</span>
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); onTabClose(path) }}
              title="Close tab"
            >
              <X size={10} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
