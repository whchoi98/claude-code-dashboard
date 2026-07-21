import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from './i18n'
import { orgParam } from './api'
import { useOrg } from './OrgProvider'

export type ToolCall = { id: string; name: string; status: 'running' | 'done' | 'error'; rowCount?: number | null }

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  toolCalls: ToolCall[]
  status?: string
  error?: string
}

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()))
const HISTORY_MAX = 12

export function useChatStream() {
  const { locale } = useI18n()
  const { org } = useOrg()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [followups, setFollowups] = useState<string[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  messagesRef.current = messages

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setMessages([]); setFollowups([]); setIsStreaming(false)
  }, [])

  // An org switch must clear the conversation: the transcript's numbers are
  // the OLD org's, and the model would happily answer follow-ups ("and who
  // was second?") from that stale context while its tools now query the new
  // org — silently cross-org AI answers. Same hard-scope rule as useFetch.
  const lastOrgRef = useRef(org)
  useEffect(() => {
    if (lastOrgRef.current !== org) {
      lastOrgRef.current = org
      reset()
    }
  }, [org, reset])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)
  }, [])

  const send = useCallback(async (text: string) => {
    const q = text.trim()
    if (!q || abortRef.current) return
    setFollowups([])

    const history = messagesRef.current
      .filter((m) => m.text.trim())
      .slice(-HISTORY_MAX)
      .map((m) => ({ role: m.role, text: m.text }))

    const asstId = newId()
    setMessages((prev) => [
      ...prev,
      { id: newId(), role: 'user', text: q, toolCalls: [] },
      { id: asstId, role: 'assistant', text: '', toolCalls: [] },
    ])
    setIsStreaming(true)

    const patch = (fn: (m: ChatMessage) => ChatMessage) =>
      setMessages((prev) => prev.map((m) => (m.id === asstId ? fn(m) : m)))

    const controller = new AbortController()
    abortRef.current = controller
    try {
      // The org rides in the body (contract: the tool runner binds to that
      // org's keys); the query param mirrors it for the shared proxy layer.
      const res = await fetch(orgParam('/api/chat/stream', org), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: q, history, locale, org }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.message || res.statusText)
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const chunks = buf.split('\n\n')
        buf = chunks.pop() || ''
        for (const chunk of chunks) {
          const lines = chunk.split('\n').filter(Boolean)
          const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim() || 'message'
          const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim()
          if (!dataLine) continue
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let data: any
          try { data = JSON.parse(dataLine) } catch { continue }
          if (ev === 'status') patch((m) => ({ ...m, status: data.message }))
          if (ev === 'text') patch((m) => ({ ...m, text: m.text + data.text, status: undefined }))
          if (ev === 'tool_call') patch((m) => ({ ...m, status: undefined, toolCalls: [...m.toolCalls, { id: data.id, name: data.name, status: 'running' }] }))
          if (ev === 'tool_result') patch((m) => ({ ...m, toolCalls: m.toolCalls.map((tc) => tc.id === data.id ? { ...tc, status: data.ok ? 'done' : 'error', rowCount: data.rowCount } : tc) }))
          if (ev === 'followups') setFollowups(Array.isArray(data.suggestions) ? data.suggestions : [])
          if (ev === 'error') patch((m) => ({ ...m, error: data.message, status: undefined }))
          if (ev === 'done') patch((m) => ({ ...m, status: undefined }))
        }
      }
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string }
      if (err?.name !== 'AbortError') patch((m) => ({ ...m, error: String(err?.message || e), status: undefined }))
    } finally {
      // Only clear if this send still owns the ref — a Stop-then-resend can
      // start a new request whose controller must not be clobbered by this
      // (now-superseded) send's late cleanup.
      if (abortRef.current === controller) {
        setIsStreaming(false)
        abortRef.current = null
      }
    }
  }, [locale, org])

  return { messages, followups, isStreaming, send, stop, reset }
}

export type ChatStream = ReturnType<typeof useChatStream>
