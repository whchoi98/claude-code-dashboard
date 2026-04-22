import clsx from 'clsx'

type Props = {
  size?: number
  animate?: boolean
  tone?: 'solid' | 'outline' | 'ghost'
  className?: string
}

/**
 * Claude asterisk/star mark — 8-pointed burst inspired by the Claude Code brand.
 * `animate` enables a gentle rotation + pulse loop. Size is driven by `size` prop (px).
 */
export function ClaudeIcon({ size = 32, animate = false, tone = 'solid', className }: Props) {
  const fill = tone === 'solid' ? '#D97757' : tone === 'outline' ? 'transparent' : 'rgba(217,119,87,0.15)'
  const stroke = tone === 'outline' ? '#D97757' : 'none'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={clsx(animate && 'animate-claude-pulse origin-center', className)}
      aria-hidden
    >
      <g fill={fill} stroke={stroke} strokeWidth={2}>
        {/* 4 cardinal rays */}
        <path d="M32 3 L35 29 L32 32 L29 29 Z" />
        <path d="M61 32 L35 35 L32 32 L35 29 Z" />
        <path d="M32 61 L29 35 L32 32 L35 35 Z" />
        <path d="M3 32 L29 29 L32 32 L29 35 Z" />
        {/* 4 diagonal rays (shorter) */}
        <path d="M12 12 L28 28 L32 32 L28 32 Z" opacity="0.85" />
        <path d="M52 12 L36 28 L32 32 L36 32 Z" opacity="0.85" />
        <path d="M52 52 L36 36 L32 32 L36 32 Z" opacity="0.85" />
        <path d="M12 52 L28 36 L32 32 L28 32 Z" opacity="0.85" />
      </g>
    </svg>
  )
}
