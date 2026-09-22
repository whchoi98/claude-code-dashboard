import { describe, expect, it } from 'vitest'
import { serializeCsv } from '../../src/lib/csv'

describe('CSV exports', () => {
  it('preserves Korean text, quoted delimiters, line breaks and exact numeric values', () => {
    expect(serializeCsv(['사용자', '비용'], [
      ['한글, "이름"\n다음 줄', 1234.5678],
      ['empty', null],
    ])).toBe('\uFEFF"사용자","비용"\r\n"한글, ""이름""\n다음 줄","1234.5678"\r\n"empty",""\r\n')
  })

  it('neutralizes spreadsheet formulas while preserving negative numeric amounts', () => {
    expect(serializeCsv(['Value'], [
      ['=1+1'], ['+cmd'], ['-cmd'], ['@SUM(A1)'], ['  =1+1'], ['\tformula'],
      [-12.5], [Number.NaN], [undefined],
    ])).toBe('\uFEFF"Value"\r\n"\'=1+1"\r\n"\'+cmd"\r\n"\'-cmd"\r\n"\'@SUM(A1)"\r\n"\'  =1+1"\r\n"\'\tformula"\r\n"-12.5"\r\n""\r\n""\r\n')
  })
})
