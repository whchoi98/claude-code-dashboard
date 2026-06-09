import clsx from 'clsx'
import { ClaudeIcon } from '../ClaudeIcon'
import { MessageList } from './MessageList'
import { ChatComposer } from './ChatComposer'
import { useI18n } from '../../lib/i18n'
import type { ChatStream } from '../../lib/useChatStream'

const FALLBACK_PROMPTS = [
  'Show DAU / WAU / MAU trends and flag any week-over-week drop > 10%.',
  'Top 10 Claude Code contributors by LOC + commits + PRs, with tool acceptance.',
  'Break down spend in USD by product and model — where is the money going?',
]

export function ChatPanel({ chat, variant, onClose }: { chat: ChatStream; variant: 'page' | 'widget'; onClose?: () => void }) {
  const { t } = useI18n()
  const { messages, followups, isStreaming, send, stop, reset } = chat
  let prompts: string[]
  try { prompts = JSON.parse(t('chat.prompts' as any)) } catch { prompts = FALLBACK_PROMPTS }

  return (
    <div className={clsx('flex flex-col', variant === 'widget' ? 'h-full' : 'min-h-[60vh]')}>
      {/* Header */}
      <div className="flex items-center justify-between px-1 pb-3 print-hide">
        <div className="flex items-center gap-2 text-[11px] text-ink-400">
          <ClaudeIcon size={16} />
          <span className="font-medium text-ink-500">Claude Sonnet 4.6</span>
        </div>
        <div className="flex items-center gap-2">
          {messages.length > 0 && (
            <button onClick={reset} className="text-[11px] px-2 py-1 rounded-lg border border-ink-200 text-ink-500 hover:bg-paper-muted/60">
              {t('chat.reset')}
            </button>
          )}
          {variant === 'widget' && onClose && (
            <button onClick={onClose} aria-label={t('common.close')} className="text-ink-400 hover:text-ink-700 px-1">✕</button>
          )}
        </div>
      </div>

      {/* Conversation */}
      <div className={clsx('flex-1 overflow-y-auto px-1 print-export', variant === 'widget' && 'pr-1')}>
        {messages.length === 0 ? (
          <div className="rounded-xl border border-ink-100 bg-white p-4">
            <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium mb-2">{t('chat.suggested')}</div>
            <div className="flex flex-wrap gap-2">
              {prompts.map((p) => (
                <button key={p} onClick={() => send(p)} className="text-[12px] px-3 py-1.5 rounded-full border border-ink-200 bg-paper-muted/40 text-ink-600 hover:bg-claude-50 hover:border-claude-200 text-left">
                  {p}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <MessageList messages={messages} />
        )}

        {/* Follow-up pills */}
        {!isStreaming && followups.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 print-hide">
            <span className="w-full text-[11px] uppercase tracking-wider text-ink-400 font-medium">{t('chat.followups')}</span>
            {followups.map((f) => (
              <button key={f} onClick={() => send(f)} className="text-[12px] px-3 py-1.5 rounded-full border border-claude-200 bg-claude-50/60 text-claude-700 hover:bg-claude-100">
                {f}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Composer */}
      <div className="mt-3 print-hide">
        <ChatComposer isStreaming={isStreaming} onSend={send} onStop={stop} />
      </div>
    </div>
  )
}
