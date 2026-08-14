import { describe, expect, it } from 'vitest'
import { filterMarkdownForWeixin, StreamingMarkdownFilter } from '../src/markdown-filter.js'

describe('Weixin Markdown compatibility', () => {
  it('preserves the Markdown subset rendered by Weixin', () => {
    const input = [
      '# Heading',
      '> quote with **bold** and *italic*',
      '- list item with `inline code`',
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '```ts',
      'const value = "**literal**"',
      '```',
    ].join('\n')

    expect(filterMarkdownForWeixin(input)).toBe(input)
  })

  it('removes Markdown image references because images use the encrypted media path', () => {
    expect(filterMarkdownForWeixin('before ![alt](https://example.com/a.png) after'))
      .toBe('before  after')
  })

  it('preserves incomplete image syntax instead of dropping user-visible text', () => {
    expect(filterMarkdownForWeixin('![alt](unfinished')).toBe('![alt](unfinished')
  })

  it('strips unsupported italic and bold-italic markers around CJK text', () => {
    expect(filterMarkdownForWeixin('*中文* / ***粗斜体*** / _日本語_ / ___안녕___'))
      .toBe('中文 / 粗斜体 / 日本語 / 안녕')
  })

  it('keeps non-CJK emphasis markers', () => {
    expect(filterMarkdownForWeixin('*italic* / ***bold italic*** / _also italic_'))
      .toBe('*italic* / ***bold italic*** / _also italic_')
  })

  it('keeps H1-H4 and strips unsupported H5-H6 markers', () => {
    expect(filterMarkdownForWeixin('# H1\n#### H4\n##### H5\n###### H6'))
      .toBe('# H1\n#### H4\nH5\nH6')
  })

  it('preserves leading indentation and trailing newlines', () => {
    expect(filterMarkdownForWeixin('  - nested item\n')).toBe('  - nested item\n')
  })

  it('produces the same result across fragmented streaming input', () => {
    const input = '标题：*中文*，值为 **42**；![图](url)'
    const filter = new StreamingMarkdownFilter()
    let streamed = ''
    for (const character of input) streamed += filter.feed(character)
    streamed += filter.flush()

    expect(streamed).toBe(filterMarkdownForWeixin(input))
    expect(streamed).toBe('标题：中文，值为 **42**；')
  })

  it('flushes ambiguous unfinished markers without losing text', () => {
    expect(filterMarkdownForWeixin('unfinished *marker')).toBe('unfinished *marker')
    expect(filterMarkdownForWeixin('trailing !')).toBe('trailing !')
  })
})
