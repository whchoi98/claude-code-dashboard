import { describe, expect, it } from 'vitest'
import { fmtCompact, shortModel } from '../../src/lib/format'

describe('compact numbers', () => {
  it('scales through k, M and B', () => {
    expect(fmtCompact(950)).toBe('950')
    expect(fmtCompact(12_340)).toBe('12.3k')
    expect(fmtCompact(4_560_000)).toBe('4.6M')
    expect(fmtCompact(11_317_700_000)).toBe('11.3B')
    expect(fmtCompact(-2_500_000_000)).toBe('-2.5B')
    expect(fmtCompact(null)).toBe('—')
  })

  it('promotes values that round up to the next unit', () => {
    expect(fmtCompact(999_949)).toBe('999.9k')
    expect(fmtCompact(999_950)).toBe('1.0M')
    expect(fmtCompact(999_960)).toBe('1.0M')
    expect(fmtCompact(-999_960)).toBe('-1.0M')
    expect(fmtCompact(999_949_999)).toBe('999.9M')
    expect(fmtCompact(999_960_000)).toBe('1.0B')
  })
})

describe('model labels', () => {
  it('joins version digits with a dot in every id spelling', () => {
    expect(shortModel('claude-opus-4-7')).toBe('opus 4.7')
    expect(shortModel('claude_opus_4_7')).toBe('opus 4.7')
    expect(shortModel('claude-sonnet-5-5')).toBe('sonnet 5.5')
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('haiku 4.5')
    expect(shortModel('claude_3_5_haiku_20241022')).toBe('3.5 haiku')
    expect(shortModel('claude-opus-4')).toBe('opus 4')
    expect(shortModel('global.anthropic.claude-sonnet-5-5')).toBe('sonnet 5.5')
    expect(shortModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('sonnet 4.5')
    expect(shortModel('us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('sonnet 4.5')
    expect(shortModel('claude-sonnet-4-5-20250929[1m]')).toBe('sonnet 4.5 [1m]')
  })

  it('leaves ids that are not Claude models readable', () => {
    expect(shortModel('unspecified')).toBe('unspecified')
  })
})
