import React from 'react'

interface ZoteroIconProps {
  size?: number
  connected?: boolean
  className?: string
}

const ZoteroIcon: React.FC<ZoteroIconProps> = ({ size = 24, className }) => {
  // Use currentColor to match other integration icons (like GitHub from lucide)
  // CSS handles the opacity/color styling via .integration-row svg
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
    >
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M9 9h6M15 9l-6 6M9 15h6" strokeLinecap="round" />
    </svg>
  )
}

export default ZoteroIcon
