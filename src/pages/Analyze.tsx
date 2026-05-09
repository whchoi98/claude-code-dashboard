import { useRef, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { ClaudeIcon } from '../components/ClaudeIcon'
import { Markdown } from '../components/Markdown'
import { useI18n } from '../lib/i18n'
import clsx from 'clsx'

type Mode = 'direct' | 'sql'

type Turn = {
  id: string
  role: 'user' | 'assistant'
  text: string
  mode?: Mode
  sql?: string
  rows?: Record<string, unknown>[]
  columns?: string[]
  status?: string
  error?: string
  done?: boolean
}

const PROMPT_KEYS_FALLBACK = [
  'What trends stand out in the last 7 days of DAU?',
  'Which users are the most active Claude Code contributors?',
  'Where is tool acceptance lowest, and what might be causing it?',
  'Which skills and connectors have the highest adoption relative to seat count?',
  'Summarize enterprise adoption health in a 3-sentence executive brief.',
]

export function Analyze() {
  const { t, locale } = useI18n()
  const [mode, setMode] = useState<Mode>('direct')
  const [question, setQuestion] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  let PROMPTS: string[]
  try { PROMPTS = JSON.parse(t('analyze.prompts' as any)) as string[] }
  catch { PROMPTS = PROMPT_KEYS_FALLBACK }

  async function ask(q: string) {
    if (!q.trim() || busy) return
    const userTurn: Turn = { id: crypto.randomUUID(), role: 'user', text: q, mode }
    const asstId = crypto.randomUUID()
    const asstTurn: Turn = { id: asstId, role: 'assistant', text: '', mode, status: t('analyze.thinking') }
    setTurns((prev) => [...prev, userTurn, asstTurn])
    setQuestion('')
    setBusy(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q, locale, mode }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message || res.statusText)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      const patch = (m: Partial<Turn>) =>
        setTurns((prev) => prev.map((t) => (t.id === asstId ? { ...t, ...m, text: m.text != null ? m.text : t.text } : t)))
      const appendText = (delta: string) =>
        setTurns((prev) => prev.map((t) => (t.id === asstId ? { ...t, text: t.text + delta, status: undefined } : t)))

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const chunks = buf.split('\n\n')
        buf = chunks.pop() || ''
        for (const chunk of chunks) {
          const lines = chunk.split('\n').filter(Boolean)
          const ev = (lines.find((l) => l.startsWith('event:'))?.slice(6).trim()) || 'message'
          const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim()
          if (!dataLine) continue
          let data: any
          try { data = JSON.parse(dataLine) } catch { continue }
          if (ev === 'status')  patch({ status: data.message })
          if (ev === 'sql')     patch({ sql: data.sql, status: 'Running query…' })
          if (ev === 'rows')    patch({ rows: data.rows, columns: data.columns, status: 'Analyzing…' })
          if (ev === 'text')    appendText(data.text)
          if (ev === 'error')   patch({ error: data.message, status: undefined })
          if (ev === 'done')    patch({ done: true, status: undefined })
        }
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
      }
    } catch (e: any) {
      setTurns((prev) => prev.map((t) => (t.id === asstId ? { ...t, error: String(e.message || e), status: undefined } : t)))
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  function stop() {
    abortRef.current?.abort()
    setBusy(false)
  }

  function exportMarkdown() {
    if (turns.length === 0) return
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
    const lines: string[] = ['# Claude Code — Analyze', '', `> ${stamp} UTC · ${t(`analyze.mode.${mode}` as any)}`, '']
    for (const turn of turns) {
      if (turn.role === 'user') {
        lines.push('---', '', `**Q.** ${turn.text}`, '')
      } else {
        if (turn.sql) lines.push('```sql', turn.sql, '```', '')
        if (turn.rows?.length && turn.columns?.length) {
          lines.push(`_${turn.rows.length} rows_`, '')
          lines.push('| ' + turn.columns.join(' | ') + ' |')
          lines.push('|' + turn.columns.map(() => '---').join('|') + '|')
          for (const r of turn.rows.slice(0, 50)) {
            lines.push('| ' + turn.columns.map((c) => String((r as any)[c] ?? '').replace(/\|/g, '\\|')).join(' | ') + ' |')
          }
          lines.push('')
        }
        if (turn.text) lines.push(turn.text, '')
        if (turn.error) lines.push(`> ⚠ ${turn.error}`, '')
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `claude-code-analyze-${new Date().toISOString().slice(0, 10)}.md`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Browser-native print → "Save as PDF" in the print dialog. The
  // app-print body class swaps in @media print rules from index.css
  // that hide everything except .print-export and auto-expand <details>.
  function exportPdf() {
    if (turns.length === 0) return
    const restore = () => document.body.classList.remove('app-print')
    document.body.classList.add('app-print')
    window.addEventListener('afterprint', restore, { once: true })
    setTimeout(() => window.print(), 50)
  }

  return (
    <div>
      <div className="print-hide">
        <PageHeader
          title={t('analyze.title')}
          subtitle={t('analyze.subtitle')}
          right={<ClaudeIcon size={28} animate />}
        />
      </div>
      <div className="p-8 space-y-5 max-w-5xl print-export">
        {/* Mode selector */}
        <div className="flex gap-2 print-hide">
          {(['direct', 'sql'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={clsx(
                'flex-1 rounded-xl border p-3 text-left transition',
                mode === m
                  ? 'border-claude-300 bg-claude-50/50 ring-1 ring-claude-200'
                  : 'border-ink-100 bg-white hover:bg-paper-muted/40',
              )}
            >
              <div className="text-sm font-semibold text-ink-800">{t(`analyze.mode.${m}` as any)}</div>
              <div className="text-[11px] text-ink-500 mt-0.5">{t(`analyze.mode.${m}.hint` as any)}</div>
            </button>
          ))}
        </div>

        {/* Export toolbar — only when there's something to export */}
        {turns.length > 0 && (
          <div className="flex justify-end gap-2 print-hide">
            <button
              onClick={exportMarkdown}
              title={t('analyze.export.md.hint')}
              className="text-[12px] px-3 py-1.5 rounded-lg border border-ink-200 bg-white text-ink-600 hover:bg-paper-muted/40 hover:border-claude-200 hover:text-ink-800 transition inline-flex items-center gap-1.5"
            >
              <span aria-hidden>↓</span>
              {t('analyze.export.md')}
            </button>
            <button
              onClick={exportPdf}
              title={t('analyze.export.pdf.hint')}
              className="text-[12px] px-3 py-1.5 rounded-lg border border-ink-200 bg-white text-ink-600 hover:bg-paper-muted/40 hover:border-claude-200 hover:text-ink-800 transition inline-flex items-center gap-1.5"
            >
              <span aria-hidden>🖨</span>
              {t('analyze.export.pdf')}
            </button>
          </div>
        )}

        {/* Conversation */}
        {turns.length === 0 && (
          <div className="rounded-xl border border-ink-100 bg-white p-5">
            <div className="text-[11px] uppercase tracking-wider text-ink-400 font-medium mb-2">Quick prompts</div>
            <div className="flex flex-wrap gap-2">
              {PROMPTS.map((p) => (
                <button
                  key={p}
                  onClick={() => ask(p)}
                  className="text-[12px] px-3 py-1.5 rounded-full border border-ink-200 bg-paper-muted/40 text-ink-600 hover:bg-claude-50 hover:border-claude-200"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((turn) => (
          <div key={turn.id} className={clsx('flex gap-3', turn.role === 'user' ? 'justify-end' : 'justify-start')}>
            {turn.role === 'assistant' && (
              <div className="w-8 h-8 rounded-full bg-claude-50 border border-claude-200 flex items-center justify-center shrink-0">
                <ClaudeIcon size={16} />
              </div>
            )}
            <div
              className={clsx(
                'rounded-2xl px-4 py-3 max-w-[80%] text-sm leading-relaxed',
                turn.role === 'user'
                  ? 'bg-claude-500 text-white'
                  : 'bg-white border border-ink-100 shadow-sm text-ink-700',
              )}
            >
              {turn.role === 'assistant' && turn.status && (
                <div className="text-[11px] text-claude-600 italic mb-1">{turn.status}</div>
              )}
              {turn.sql && (
                <details className="mb-2 text-[11px]">
                  <summary className="cursor-pointer text-ink-500 hover:text-ink-700 select-none">SQL</summary>
                  <pre className="mt-1 p-2 bg-ink-800 text-paper rounded font-mono text-[10px] overflow-x-auto whitespace-pre-wrap">
                    {turn.sql}
                  </pre>
                </details>
              )}
              {turn.rows && turn.rows.length > 0 && (
                <details className="mb-2 text-[11px]">
                  <summary className="cursor-pointer text-ink-500 hover:text-ink-700 select-none">
                    {turn.rows.length} rows
                  </summary>
                  <div className="mt-1 max-h-44 overflow-auto border border-ink-100 rounded">
                    <table className="w-full text-[10px]">
                      <thead className="bg-paper-muted/60 text-ink-500 sticky top-0">
                        <tr>{(turn.columns || []).map((c) => <th key={c} className="text-left px-2 py-1">{c}</th>)}</tr>
                      </thead>
                      <tbody>
                        {turn.rows.slice(0, 50).map((r, i) => (
                          <tr key={i} className="border-t border-ink-100">
                            {(turn.columns || []).map((c) => (
                              <td key={c} className="px-2 py-0.5 tabular-nums">{String((r as any)[c] ?? '')}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
              {turn.role === 'assistant'
                ? (turn.text
                    ? <Markdown>{turn.text}</Markdown>
                    : !turn.error && <span className="text-ink-400">…</span>)
                : <div className="whitespace-pre-wrap">{turn.text}</div>}
              {turn.error && (
                <div className="mt-2 text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1">
                  {turn.error}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} className="print-hide" />

        {/* Composer */}
        <div className="sticky bottom-6 print-hide">
          <div className="rounded-xl border border-ink-100 bg-white shadow-card p-4">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  ask(question)
                }
              }}
              rows={2}
              placeholder={t('analyze.placeholder')}
              className="w-full text-sm bg-paper-muted/30 border border-ink-100 rounded-lg px-4 py-3 focus:outline-none focus:border-claude-500 resize-none"
            />
            <div className="mt-3 flex items-center justify-between">
              <div className="text-[11px] text-ink-400">
                Mode: <span className="font-semibold text-ink-600">{t(`analyze.mode.${mode}` as any)}</span>
              </div>
              <div className="flex gap-2">
                {busy && (
                  <button
                    onClick={stop}
                    className="text-sm px-3 py-1.5 rounded-lg border border-ink-200 text-ink-500 hover:bg-paper-muted"
                  >
                    Stop
                  </button>
                )}
                <button
                  onClick={() => ask(question)}
                  disabled={busy || !question.trim()}
                  className="inline-flex items-center gap-2 px-4 py-1.5 rounded-lg bg-claude-500 hover:bg-claude-600 disabled:opacity-50 text-white text-sm font-medium"
                >
                  <ClaudeIcon size={14} tone="ghost" className="opacity-90" />
                  {busy ? t('analyze.thinking') : t('analyze.run')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
