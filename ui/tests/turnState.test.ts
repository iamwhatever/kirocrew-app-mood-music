import { describe, expect, it } from 'vitest'
import { activityKey, buddyStatus, conversation, liveSteps, pendingApproval, personText, stepsOf, turnError } from '../src/turnState'

const user = (content = '[Mood Music]\nMood: 想念\n\nExplore level: balanced') => ({ role: 'user', content })
const tool = (name: string) => ({ role: 'tool', content: `${name} something`, meta: { tool_name: name } })

describe('personText', () => {
  it('keeps only the person’s words from a request the page sent', () => {
    expect(personText('[Mood Music]\nMood: 想念\n\nTaste so far: ...')).toBe('想念')
    expect(personText('[Mood Music]\nFollow-up: 再安静一点\n')).toBe('再安静一点')
    expect(personText('typed in the full chat')).toBe('typed in the full chat')
  })
})

describe('conversation', () => {
  it('draws the person’s words and the buddy’s prose, nothing else', () => {
    const lines = conversation({ messages: [user(), tool('web_search'), { role: 'assistant', content: 'Quiet missing.\n```mood-music\n{}\n```' }] })
    expect(lines.map(l => [l.who, l.text])).toEqual([['you', '想念'], ['buddy', 'Quiet missing.']])
  })

  it('keeps only the last reply of a turn, and none while it runs', () => {
    const rows = [user(), { role: 'assistant', content: "I'll search first." }, tool('web_search'), { role: 'assistant', content: 'Here.\n```mood-music\n{}\n```' }]
    expect(conversation({ running: false, messages: rows }).map(l => l.text)).toEqual(['想念', 'Here.'])
    expect(conversation({ running: true, messages: rows }).map(l => l.text)).toEqual(['想念'])
  })
})

describe('buddyStatus', () => {
  it('counts searches and pages in the current turn only', () => {
    const slot = { running: true, messages: [user(), tool('web_search'), user(), tool('web_search'), tool('web_fetch'), tool('web_fetch')] }
    expect(buddyStatus(slot, false)).toEqual({ phase: 'reading', searches: 1, pages: 2 })
  })
  it('reads a live row that names its tool only in its title', () => {
    const slot = { running: true, messages: [user(), { role: 'tool', content: '🔧 web_search' }, { role: 'tool', content: '🔧 Fetch URL' }] }
    expect(buddyStatus(slot, false)).toEqual({ phase: 'reading', searches: 1, pages: 1 })
    expect(buddyStatus({ running: true, messages: [user(), { role: 'assistant', content: 'note' }] }, false)?.phase).toBe('thinking')
  })

  it('is null when nothing runs, and checking while the page verifies', () => {
    expect(buddyStatus({ running: false, messages: [user()] }, false)).toBeNull()
    expect(buddyStatus({ running: false, messages: [user()] }, true)?.phase).toBe('checking')
  })
})

describe('pendingApproval', () => {
  it('finds the unanswered one in this turn, with the host it wants', () => {
    const ask = { role: 'permission', content: 'web_fetch', meta: { approval_id: 'r1', tool_input: '{"url":"https://Music.Example.org/x"}' } }
    expect(pendingApproval({ messages: [user(), ask] })).toEqual({ id: 'r1', host: 'music.example.org' })
    expect(pendingApproval({ messages: [user(), { ...ask, meta: { ...ask.meta, resolved: 'approved' } }] })).toBeNull()
    expect(pendingApproval({ messages: [ask, user()] })).toBeNull()
    expect(pendingApproval({ messages: [user(), { role: 'permission', content: 'x', meta: {} }] })).toBeNull()
  })
})

describe('turnError', () => {
  it('reads a failure but not an auto-retry notice', () => {
    expect(turnError({ messages: [user(), { role: 'error', content: '  boom \n now ' }] })).toBe('boom now')
    expect(turnError({ messages: [user(), { role: 'error', content: 'retry', meta: { kind: 'transient_retry' } }] })).toBe('')
    expect(turnError({ messages: [{ role: 'error', content: 'old' }, user()] })).toBe('')
  })
})

describe('activityKey', () => {
  it('changes when a row lands or grows', () => {
    const a = activityKey({ running: true, messages: [user()] })
    expect(activityKey({ running: true, messages: [user(), { role: 'streaming', content: 'a' }] })).not.toBe(a)
    expect(activityKey({ running: true, messages: [user()] })).toBe(a)
  })
})

describe('steps', () => {
  const browser = (op: string) => ({ role: 'tool', content: '🔧 browser', meta: { input: JSON.stringify({ op, args: { url: 'https://www.youtube.com/results?search_query=x' } }) } })

  it('names each step in plain kinds, folding a run of one kind', () => {
    const rows = [tool('web_search'), tool('web_search'), { role: 'tool', content: '🔧 Fetch URL' }, browser('navigate'), browser('click'), browser('click'), { role: 'tool', content: '🔧 browser', meta: { input: { op: 'tabs' } } }, browser('reflex')]
    expect(stepsOf(rows)).toEqual([
      { kind: 'search', count: 2 }, { kind: 'read', count: 1 }, { kind: 'open', count: 1 },
      { kind: 'click', count: 2 }, { kind: 'tab', count: 1 }, { kind: 'browser', count: 1 },
    ])
  })

  it('puts each turn’s steps on its buddy line, and the running turn’s in liveSteps', () => {
    const rows = [user(), tool('web_search'), { role: 'assistant', content: 'Here.' }, user(), browser('navigate')]
    const lines = conversation({ running: true, messages: rows })
    expect(lines[1]).toMatchObject({ who: 'buddy', steps: [{ kind: 'search', count: 1 }] })
    expect(liveSteps({ running: true, messages: rows })).toEqual([{ kind: 'open', count: 1 }])
    expect(liveSteps({ running: false, messages: rows })).toEqual([])
  })
})
