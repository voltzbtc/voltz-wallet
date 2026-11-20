type Translate = (key: string, options: { first: string; second: string }) => string

// The labels a screen reader hears as one, and two sentences drawn as one paragraph, joined by the
// language: Chinese, Japanese, Arabic and Urdu have commas of their own, and Chinese and Japanese put
// no space between sentences. What was never read is left out.
export function joinLabels(t: Translate, parts: (string | null | undefined)[]): string {
  return join(t, 'common.twoLabels', parts)
}

export function joinSentences(t: Translate, parts: (string | null | undefined)[]): string {
  return join(t, 'common.twoSentences', parts)
}

function join(t: Translate, key: string, parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).reduce((first, second) => t(key, { first, second }))
}
