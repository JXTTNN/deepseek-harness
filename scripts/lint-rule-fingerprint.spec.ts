import { createHash } from 'node:crypto'
impo rt { readFileSync } from 'node:fs'
import { f ileURLToPath } from 'node:url'
import { flatt enDiagnosticMessageText, parseConfigFileTextT oJson } from 'typescript'
import { describe,  expect, it } from 'vitest'

type Rules = Reco rd<string, unknown>

interface Profile {
  re adonly count: number
  readonly indexes: read only number[]
  readonly sha256: string
}

//  A one-time audit against eslint.config.mjs b lob 696b08282885296830189fdafe7051a356806fc2
 // mapped @typescript-eslint/* to typescript/ * and four extension rules to their
// Oxlint  core equivalents. These fingerprints pin the  resulting repository
// snapshot; they do no t re-evaluate that deleted baseline or track  its preset.
const profiles = {
  source: {
     count: 88,
    indexes: [0, 1, 4, 5],
    s ha256: 'da1dfd77cb6eb66be93d8d3820f9b9b68b7aa 391c24680f8851c0910298f9e3b',
  },
  example:  {
    count: 87,
    indexes: [0, 1, 2, 4, 5 ],
    sha256: '6a2606053bc1ec1de3b02611de88e a51d201dac13a1f193e4934d33c08b95f08',
  },
   test: {
    count: 83,
    indexes: [0, 3, 4,  5],
    sha256: '7995e14926a36c40bd65c474637 735222a95fb030395681685f03060e50a7b78',
  },
 } as const satisfies Record<string, Profile>
 
function isRecord(value: unknown): value is  Record<string, unknown> {
  return typeof val ue === 'object' && value !== null && !Array.i sArray(value)
}

function isUnknownArray(valu e: unknown): value is unknown[] {
  return Ar ray.isArray(value)
}

function severity(value : unknown): 0 | 1 | 2 {
  const level = isUnk nownArray(value) ? value[0] : value
  if (lev el === 'off' || level === 0) return 0
  if (l evel === 'warn' || level === 'warning' || lev el === 1) return 1
  if (level === 'error' ||  level === 2) return 2
  throw new Error(`uns upported lint severity: ${JSON.stringify(leve l)}`)
}

function normalizedRules(rules: Rule s): Rules {
  return Object.fromEntries(Objec t.entries(rules)
    .filter(([, value]) => s everity(value) > 0)
    .sort(([left], [right ]) => left.localeCompare(right))
    .map(([n ame, value]) => {
      const options = isUnk nownArray(value) ? value.slice(1) : []
       return [name, [severity(value), ...options]]
     }))
}

function mergedRules(overrides: re adonly unknown[], indexes: readonly number[]) : Rules {
  const merged: Rules = {}
  for (c onst index of indexes) {
    const override =  overrides[index]
    if (!isRecord(override)  || !isRecord(override.rules)) {
      throw  new Error(`.oxlintrc.json override ${index} m ust contain a rules object`)
    }
    Object .assign(merged, override.rules)
  }
  return  normalizedRules(merged)
}

describe('Oxlint r epository rule fingerprint', () => {
  const  path = fileURLToPath(new URL('../.oxlintrc.js on', import.meta.url))
  const result = parse ConfigFileTextToJson(path, readFileSync(path,  'utf8'))
  if (result.error !== undefined) { 
    throw new Error(flattenDiagnosticMessage Text(result.error.messageText, '\n'))
  }
  c onst parsed: unknown = result.config
  if (!i sRecord(parsed) || !Array.isArray(parsed.over rides)) {
    throw new Error('.oxlintrc.json  must contain an overrides array')
  }
  cons t overrides: readonly unknown[] = parsed.over rides

  it('pins every override field', () = > {
    expect(overrides).toHaveLength(10)
  } )

  it.each(Object.entries(profiles))('pins  the %s rule profile', (_name, profile) => {
     const rules = mergedRules(overrides, profi le.indexes)
    const fingerprint = createHas h('sha256').update(JSON.stringify(rules)).dig est('hex')

    expect(Object.keys(rules)).to HaveLength(profile.count)
    expect(fingerpr int).toBe(profile.sha256)
  })
})
 