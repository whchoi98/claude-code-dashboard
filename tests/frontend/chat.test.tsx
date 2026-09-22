import { StrictMode, type ReactNode } from 'react'
import { act, createEvent, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { ChatComposer } from '../../src/components/chat/ChatComposer'
import { I18nProvider } from '../../src/lib/i18n'
import { OrgProvider, useOrg } from '../../src/lib/OrgProvider'
import { useChatStream } from '../../src/lib/useChatStream'

type ChatRequest = {
  url: string
  body: {
    message: string
    history: { role: string; text: string }[]
    locale: string
    org: string
  }
  signal: AbortSignal
  respond: () => void
  reject: (error: Error) => void
  chunk: (text: string) => void
  event: (name: string, data: unknown) => void
  close: () => void
  fail: (error: Error) => void
}

// Only the network is replaced. Deliberately allow data after abort so a
// cooperative fetch implementation cannot hide missing request ownership checks.
function mockChatServer() {
  const requests: ChatRequest[] = []
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/orgs') {
      return Promise.resolve(Response.json({
        orgs: [
          { id: 'primary', label: 'Primary', admin: true, compliance: true },
          { id: 'org2', label: 'Second org', admin: true, compliance: true },
        ],
        default: 'primary',
      }))
    }
    if (!url.startsWith('/api/chat/stream')) throw new Error(`Unexpected fetch: ${url}`)

    let controller!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({
      start(value) { controller = value },
    })
    const response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    const encoder = new TextEncoder()
    const chunk = (text: string) => controller.enqueue(encoder.encode(text))
    return new Promise<Response>((resolve, reject) => {
      requests.push({
        url,
        body: JSON.parse(String(init?.body)),
        signal: init?.signal as AbortSignal,
        respond: () => resolve(response),
        reject,
        chunk,
        event: (name, data) => chunk(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
        close: () => controller.close(),
        fail: (error) => controller.error(error),
      })
    })
  })
  return requests
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <StrictMode>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <I18nProvider>
          <OrgProvider>{children}</OrgProvider>
        </I18nProvider>
      </MemoryRouter>
    </StrictMode>
  )
}

function useChatHarness() {
  return { chat: useChatStream(), ...useOrg() }
}

async function mountChat() {
  const hook = renderHook(useChatHarness, { wrapper: Providers })
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}

function ComposerHarness() {
  const chat = useChatStream()
  return (
    <>
      <ChatComposer isStreaming={chat.isStreaming} onSend={chat.send} onStop={chat.stop} />
      <output data-testid="transcript">{JSON.stringify(chat.messages)}</output>
    </>
  )
}

beforeEach(() => {
  window.localStorage.setItem('ccd.locale', 'en')
})

describe('useChatStream request lifecycle', () => {
  it('streams status, tools, split text events, and follow-ups with scoped history', async () => {
    const requests = mockChatServer()
    const { result } = await mountChat()
    let sending!: Promise<void>
    act(() => { sending = result.current.chat.send('  Show usage  ') })
    const request = requests[0]
    expect(request.url).toBe('/api/chat/stream')
    expect(request.body).toEqual({ message: 'Show usage', history: [], locale: 'en', org: 'primary' })
    expect(result.current.chat.isStreaming).toBe(true)

    await act(async () => {
      request.respond()
      request.event('status', { message: 'Looking up usage' })
    })
    expect(result.current.chat.messages[1].status).toBe('Looking up usage')

    await act(async () => {
      request.event('tool_call', { id: 'tool-1', name: 'run_athena_sql', input: { sql: 'SELECT 1' } })
    })
    expect(result.current.chat.messages[1].toolCalls[0].status).toBe('running')

    await act(async () => {
      request.event('tool_result', { id: 'tool-1', name: 'run_athena_sql', ok: true, rowCount: 1 })
      request.chunk('event: text\ndata: {"text":"활성 사용')
      request.chunk('자 10명"}\n\nevent: text\ndata: {"text":"입니다."}\n\n')
      request.event('followups', { suggestions: ['지난주와 비교해 줘'] })
      request.event('done', { ok: true, modelId: 'test-model', hops: 1 })
      request.close()
      await sending
    })
    expect(result.current.chat.messages[1]).toMatchObject({
      text: '활성 사용자 10명입니다.',
      status: undefined,
      toolCalls: [{ id: 'tool-1', name: 'run_athena_sql', status: 'done', rowCount: 1 }],
    })
    expect(result.current.chat.messages[1].error).toBeUndefined()
    expect(result.current.chat.followups).toEqual(['지난주와 비교해 줘'])
    expect(result.current.chat.isStreaming).toBe(false)

    act(() => { void result.current.chat.send('Compare last week') })
    expect(requests[1].body.history).toEqual([
      { role: 'user', text: 'Show usage' },
      { role: 'assistant', text: '활성 사용자 10명입니다.' },
    ])
  })

  it('aborts an in-flight request on unmount', async () => {
    const requests = mockChatServer()
    const { result, unmount } = await mountChat()
    act(() => { void result.current.chat.send('Show usage') })

    unmount()

    expect(requests[0].signal.aborted).toBe(true)
  })

  it('reset allows a same-tick send with empty history before the old fetch settles', async () => {
    const requests = mockChatServer()
    const { result } = await mountChat()
    let oldSending!: Promise<void>
    act(() => { oldSending = result.current.chat.send('Old question') })

    act(() => {
      result.current.chat.reset()
      void result.current.chat.send('Fresh question')
    })

    expect(requests[0].signal.aborted).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[1].body.history).toEqual([])
    expect(result.current.chat.messages.map((message) => message.text)).toEqual(['Fresh question', ''])

    await act(async () => {
      requests[0].respond()
      requests[0].event('followups', { suggestions: ['Old suggestion'] })
      requests[0].event('done', { ok: true })
      requests[0].close()
      await oldSending
    })
    expect(result.current.chat.followups).toEqual([])
    expect(result.current.chat.isStreaming).toBe(true)
    act(() => { result.current.chat.stop() })
    expect(requests[1].signal.aborted).toBe(true)
  })

  it('ignores late events after Stop while a replacement request still owns the stream', async () => {
    const requests = mockChatServer()
    const { result } = await mountChat()
    let oldSending!: Promise<void>
    act(() => { oldSending = result.current.chat.send('Old question') })
    await act(async () => {
      requests[0].respond()
      requests[0].event('text', { text: 'Partial answer' })
    })

    act(() => {
      result.current.chat.stop()
      void result.current.chat.send('New question')
    })
    expect(requests[0].signal.aborted).toBe(true)
    expect(requests).toHaveLength(2)

    await act(async () => {
      requests[0].event('text', { text: ' LEAKED' })
      requests[0].event('status', { message: 'Old status' })
      requests[0].event('tool_call', { id: 'late-tool', name: 'search_users', input: {} })
      requests[0].event('followups', { suggestions: ['Old suggestion'] })
      requests[0].event('error', { message: 'Old error' })
      requests[0].close()
      await oldSending
    })

    expect(result.current.chat.messages[1]).toMatchObject({ text: 'Partial answer', toolCalls: [] })
    expect(result.current.chat.messages[1].status).toBeUndefined()
    expect(result.current.chat.messages[1].error).toBeUndefined()
    expect(result.current.chat.followups).toEqual([])
    expect(result.current.chat.isStreaming).toBe(true)
    act(() => { void result.current.chat.send('Must not overlap the new request') })
    expect(requests).toHaveLength(2)
    act(() => { result.current.chat.stop() })
    expect(requests[1].signal.aborted).toBe(true)
  })

  it('does not expose the old transcript in any new-org render', async () => {
    const requests = mockChatServer()
    const frames: { org: string; texts: string[]; followups: string[]; streaming: boolean }[] = []
    const { result } = renderHook(() => {
      const value = useChatHarness()
      frames.push({
        org: value.org,
        texts: value.chat.messages.map((message) => message.text),
        followups: value.chat.followups,
        streaming: value.chat.isStreaming,
      })
      return value
    }, { wrapper: Providers })
    await waitFor(() => expect(result.current.loading).toBe(false))
    let oldSending!: Promise<void>
    act(() => { oldSending = result.current.chat.send('Primary-only question') })
    await act(async () => {
      requests[0].respond()
      requests[0].event('text', { text: 'Primary-only data' })
      requests[0].event('followups', { suggestions: ['Primary-only suggestion'] })
    })
    frames.length = 0

    act(() => { result.current.setOrg('org2') })

    expect(result.current.org).toBe('org2')
    const newOrgFrames = frames.filter((frame) => frame.org === 'org2')
    expect(newOrgFrames.length).toBeGreaterThan(0)
    expect(newOrgFrames.every((frame) => frame.texts.length === 0 && frame.followups.length === 0 && !frame.streaming)).toBe(true)
    expect(requests[0].signal.aborted).toBe(true)

    act(() => { void result.current.chat.send('Org2 question') })
    expect(requests).toHaveLength(2)
    expect(requests[1].url).toBe('/api/chat/stream?org=org2')
    expect(requests[1].body).toMatchObject({ org: 'org2', history: [], message: 'Org2 question' })

    await act(async () => {
      requests[0].event('followups', { suggestions: ['Late primary suggestion'] })
      requests[0].event('status', { message: 'Late primary status' })
      requests[0].close()
      await oldSending
    })
    expect(result.current.chat.followups).toEqual([])
    expect(result.current.chat.messages.map((message) => message.text)).toEqual(['Org2 question', ''])
    expect(result.current.chat.isStreaming).toBe(true)

    act(() => { result.current.setOrg('primary') })
    expect(requests[1].signal.aborted).toBe(true)
    expect(result.current.chat.messages).toEqual([])
  })

  it('settles status and running tools when Stop preserves a partial answer', async () => {
    const requests = mockChatServer()
    const { result } = await mountChat()
    act(() => { void result.current.chat.send('Show usage') })
    await act(async () => {
      requests[0].respond()
      requests[0].event('text', { text: 'Partial answer' })
      requests[0].event('tool_call', { id: 'tool-1', name: 'run_athena_sql', input: {} })
      requests[0].event('status', { message: 'Still querying' })
    })

    act(() => { result.current.chat.stop() })

    expect(result.current.chat.messages[1].text).toBe('Partial answer')
    expect(result.current.chat.messages[1].status).toBeUndefined()
    expect(result.current.chat.messages[1].toolCalls[0].status).toBe('error')
    expect(result.current.chat.isStreaming).toBe(false)
  })

  it('settles an empty assistant placeholder when stopped before any tokens arrive', async () => {
    mockChatServer()
    const { result } = await mountChat()
    act(() => { void result.current.chat.send('Show usage') })

    act(() => { result.current.chat.stop() })

    expect(result.current.chat.messages[1].error).toBe('Response interrupted. Please try again.')
    expect(result.current.chat.isStreaming).toBe(false)
  })

  it.each(['done', 'error'])('ends the request at %s without waiting for the server to close the body', async (event) => {
    const requests = mockChatServer()
    const { result } = await mountChat()
    let sending!: Promise<void>
    act(() => { sending = result.current.chat.send('Show usage') })
    await act(async () => {
      requests[0].respond()
      requests[0].event('text', { text: 'Answer' })
      requests[0].event(event, event === 'done' ? { ok: true } : { message: 'Query failed' })
    })

    expect(result.current.chat.isStreaming).toBe(false)
    expect(result.current.chat.messages[1].error).toBe(event === 'done' ? undefined : 'Query failed')
    await sending
    act(() => { void result.current.chat.send('Next question') })
    expect(requests).toHaveLength(2)
  })

  it.each(['eof', 'network error', 'server error'] as const)('settles running tools after %s', async (ending) => {
    const requests = mockChatServer()
    const { result } = await mountChat()
    let sending!: Promise<void>
    act(() => { sending = result.current.chat.send('Show usage') })
    await act(async () => {
      requests[0].respond()
      requests[0].event('tool_call', { id: 'tool-1', name: 'run_athena_sql', input: {} })
      requests[0].event('status', { message: 'Still querying' })
    })
    await act(async () => {
      if (ending === 'network error') requests[0].fail(new Error('Connection lost'))
      else {
        if (ending === 'server error') requests[0].event('error', { message: 'Query failed' })
        requests[0].close()
      }
      await sending
    })

    const assistant = result.current.chat.messages[1]
    expect(assistant.error).toBe(
      ending === 'eof' ? 'Response interrupted. Please try again.'
        : ending === 'network error' ? 'Connection lost' : 'Query failed',
    )
    expect(assistant.status).toBeUndefined()
    expect(assistant.toolCalls[0].status).toBe('error')
    expect(result.current.chat.isStreaming).toBe(false)
  })
})

describe('ChatComposer keyboard input', () => {
  it('gives the textarea an accessible name', () => {
    mockChatServer()
    render(<ComposerHarness />, { wrapper: Providers })

    expect(screen.getByRole('textbox').getAttribute('aria-label')).toBe('Ask about your analytics')
  })

  it.each([
    { name: 'native isComposing', isComposing: true, keyCode: 13 },
    { name: 'IME keyCode 229 after compositionend', isComposing: false, keyCode: 229 },
  ])('keeps $name Enter for composition, then sends on a regular Enter', async ({ isComposing, keyCode }) => {
    const requests = mockChatServer()
    render(<ComposerHarness />, { wrapper: Providers })
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.compositionStart(textarea)
    fireEvent.change(textarea, { target: { value: '사용량을 알려 줘' } })
    if (!isComposing) fireEvent.compositionEnd(textarea)
    const composingEnter = createEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing, keyCode })

    fireEvent(textarea, composingEnter)

    expect(requests).toHaveLength(0)
    expect(textarea.value).toBe('사용량을 알려 줘')
    expect(composingEnter.defaultPrevented).toBe(false)

    fireEvent.compositionEnd(textarea)
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', isComposing: false, keyCode: 13 })
    expect(requests).toHaveLength(1)
    expect(requests[0].body.message).toBe('사용량을 알려 줘')
    expect(textarea.value).toBe('')
    expect(screen.getByTestId('transcript').textContent).toContain('사용량을 알려 줘')

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(requests[0].signal.aborted).toBe(true)
    await act(async () => { requests[0].reject(new DOMException('Aborted', 'AbortError')) })
  })

  it('leaves Shift+Enter available for a newline and sends multiline text with Enter', () => {
    const requests = mockChatServer()
    render(<ComposerHarness />, { wrapper: Providers })
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'First line' } })
    const newline = createEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true })

    fireEvent(textarea, newline)

    expect(newline.defaultPrevented).toBe(false)
    expect(requests).toHaveLength(0)
    fireEvent.change(textarea, { target: { value: 'First line\nSecond line' } })
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' })
    expect(requests[0].body.message).toBe('First line\nSecond line')
  })
})
