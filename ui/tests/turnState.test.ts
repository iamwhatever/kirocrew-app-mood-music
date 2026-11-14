import { describe, expect, it } from 'vitest'
import { activityKey, buddyStatus, conversation, pendingApproval, personText, turnError } from '../src/turnState'

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
})

describe('buddyStatus', () => {
  it('counts searches and pages in the current turn only', () => {
    const slot = { running: true, messages: [user(), tool('web_search'), user(), tool('web_search'), tool('web_fetch'), tool('web_fetch')] }
    expect(buddyStatus(slot, false)).toEqual({ phase: 'reading', searches: 1, pages: 2 })
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
