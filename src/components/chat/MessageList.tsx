import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { ClaudeIcon } from '../ClaudeIcon'
import { Markdown } from '../Markdown'
import { useI18n } from '../../lib/i18n'
import type { ChatMessage, ToolCall } from '../../lib/useChatStream'

function TypingDots() {
  const { t } = useI18n()
  return (
    <span className="inline-flex gap-1 py-1" aria-label={t('chat.thinking')}>
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-1.5 h-1.5 rounded-full bg-claude-400 animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
      ))}
    </span>
  )
}

function ToolBadge({ tc }: { tc: ToolCall }) {
  const { t } = useI18n()
  const label = t(`chat.tool.${tc.name}` as any)
  return (
    <span className={clsx(
      'inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full border',
      tc.status === 'error'
        ? 'bg-rose-50 border-rose-200 text-rose-700'
        : 'bg-violet-50 border-violet-200 text-violet-700',
    )}>
      <span aria-hidden>{tc.status === 'running' ? '⟳' : tc.status === 'error' ? '⚠' : '✓'}</span>
      {label}{tc.rowCount != null ? ` · ${tc.rowCount}` : ''}
    </span>
  )
}

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const bottomRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  return (
    <div className="space-y-4">
      {messages.map((m) => (
        <div key={m.id} className={clsx('flex gap-3', m.role === 'user' ? 'justify-end' : 'justify-start')}>
          {m.role === 'assistant' && (
            <div className="w-8 h-8 rounded-full bg-claude-50 border border-claude-200 flex items-center justify-center shrink-0">
              <ClaudeIcon size={16} />
            </div>
          )}
          <div className={clsx(
            'rounded-2xl px-4 py-3 max-w-[80%] text-sm leading-relaxed',
            m.role === 'user' ? 'bg-claude-500 text-white' : 'bg-white border border-ink-100 shadow-sm text-ink-700',
          )}>
            {m.toolCalls.length > 0 && (
              <div className="flex flex-wrap gap-1 mb-2">{m.toolCalls.map((tc) => <ToolBadge key={tc.id} tc={tc} />)}</div>
            )}
            {m.role === 'assistant' && m.status && (
              <div className="text-[11px] text-claude-600 italic mb-1">{m.status}</div>
            )}
            {m.role === 'assistant'
              ? (m.text ? <Markdown>{m.text}</Markdown> : !m.error && <TypingDots />)
              : <div className="whitespace-pre-wrap">{m.text}</div>}
            {m.error && (
              <div className="mt-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">{m.error}</div>
            )}
          </div>
        </div>
      ))}
      <div ref={bottomRef} className="print-hide" />
    </div>
  )
}
