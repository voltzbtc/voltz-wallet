import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { runInNewContext } from 'vm'
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import '../src/i18n'
import { RootNavigator } from '../src/navigation/RootNavigator'
import { __setEmergencyExitLiveForTests, EMERGENCY_EXIT_LIVE, emergencyExitLive } from '../src/wallet/emergencyExit'
import { useHomeExit } from '../src/hooks/useHomeExit'
import { runExitPass } from '../src/wallet/exitPass'
import { loadExitPlan } from '../src/wallet/exitPlan'

const mockScreens: string[] = []
jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({
    Navigator: ({ children }: { children: React.ReactNode }) => children,
    Screen: ({ name }: { name: string }) => {
      mockScreens.push(name)
      return null
    },
  }),
}))
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    ...jest.requireActual('@react-navigation/native'),
    useFocusEffect: (effect: () => void | (() => void)) => react.useEffect(effect, [effect]),
  }
})
jest.mock('../src/wallet/exitPass', () => ({
  ...jest.requireActual('../src/wallet/exitPass'),
  runExitPass: jest.fn(async () => ({ kind: 'idle' })),
}))
jest.mock('../src/wallet/exitPlan', () => ({
  ...jest.requireActual('../src/wallet/exitPlan'),
  loadExitPlan: jest.fn(async () => null),
}))

const routes = async (): Promise<string[]> => {
  mockScreens.length = 0
  let tree: ReactTestRenderer.ReactTestRenderer | null = null
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<RootNavigator />)
  })
  await ReactTestRenderer.act(async () => (tree as unknown as ReactTestRenderer.ReactTestRenderer).unmount())
  return [...mockScreens]
}

beforeEach(() => jest.clearAllMocks())
afterEach(() => __setEmergencyExitLiveForTests(null))

test('the exit ships switched on', () => {
  expect(EMERGENCY_EXIT_LIVE).toBe(true)
  expect(emergencyExitLive()).toBe(true)
})

test('under Jest the seam forces the switch either way, and null hands it back', () => {
  __setEmergencyExitLiveForTests(false)
  expect(emergencyExitLive()).toBe(false)
  __setEmergencyExitLiveForTests(true)
  expect(emergencyExitLive()).toBe(true)
  __setEmergencyExitLiveForTests(false)
  __setEmergencyExitLiveForTests(null)
  expect(emergencyExitLive()).toBe(EMERGENCY_EXIT_LIVE)
})

// The module as a bundle gets it: Babel inlines NODE_ENV from the environment its process started with
// (react-native-dotenv takes a copy once), so each build runs in a process of its own, as a Metro worker
// does, and Metro sets __DEV__. Built both ways the switch can ship, each direction is an ask that would
// change it. The build for Jest is the control that shows the harness sees a change.
describe('outside Jest the seam changes nothing, whichever way it is asked or the switch ships', () => {
  type Switch = typeof import('../src/wallet/emergencyExit')
  const root = path.join(__dirname, '..')
  const file = path.join(root, 'src/wallet/emergencyExit.ts')
  const SHIPPED = 'export const EMERGENCY_EXIT_LIVE = true\n'
  const TRANSFORM = `
    const { transformSync } = require('@babel/core')
    const { file, config, sources } = JSON.parse(require('fs').readFileSync(0, 'utf8'))
    const codes = sources.map(source => transformSync(source, { filename: file, babelrc: false, configFile: config }).code)
    process.stdout.write(JSON.stringify(codes))
  `

  const built = (nodeEnv: string, dev: boolean): Record<'on' | 'off', Switch> => {
    const source = fs.readFileSync(file, 'utf8')
    expect(source).toContain(SHIPPED)
    const sources = [true, false].map(shipped => source.replace(SHIPPED, `export const EMERGENCY_EXIT_LIVE = ${shipped}\n`))
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: nodeEnv }
    delete env.BABEL_ENV
    const out = execFileSync(process.execPath, ['-e', TRANSFORM], {
      cwd: root,
      env,
      input: JSON.stringify({ file, config: path.join(root, 'babel.config.js'), sources }),
    })
    const [on, off] = (JSON.parse(out.toString()) as string[]).map(code => {
      const module = { exports: {} }
      runInNewContext(code, { module, exports: module.exports, __DEV__: dev })
      return module.exports as Switch
    })
    return { on, off }
  }

  test.each([
    ['a release bundle', 'production', false],
    ['a development bundle', 'development', true],
  ])('%s', (_, nodeEnv, dev) => {
    const { on, off } = built(nodeEnv as string, dev as boolean)
    for (const [exit, shipped] of [[on, true], [off, false]] as const) {
      expect(exit.EMERGENCY_EXIT_LIVE).toBe(shipped)
      for (const asked of [!shipped, shipped, null]) {
        exit.__setEmergencyExitLiveForTests(asked)
        expect(exit.emergencyExitLive()).toBe(shipped)
      }
    }
  }, 30_000)

  test('control: the same build for Jest is forced', () => {
    const { on, off } = built('test', true)
    on.__setEmergencyExitLiveForTests(false)
    off.__setEmergencyExitLiveForTests(true)
    expect([on.emergencyExitLive(), off.emergencyExitLive()]).toEqual([false, true])
  }, 30_000)
})

test('the route exists only with the switch on', async () => {
  const shipped = await routes()
  expect(shipped).toContain('Send')
  expect(shipped).toContain('EmergencyExit')
  __setEmergencyExitLiveForTests(false)
  const off = await routes()
  expect(off).toContain('Send')
  expect(off).not.toContain('EmergencyExit')
})

describe("Home's pass", () => {
  const Probe = ({ onEnd }: { onEnd: () => void }): null => {
    useHomeExit('primary', onEnd)
    return null
  }

  const render = async (onEnd: () => void) => {
    let tree: ReactTestRenderer.ReactTestRenderer | null = null
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<Probe onEnd={onEnd} />)
    })
    await ReactTestRenderer.act(async () => (tree as unknown as ReactTestRenderer.ReactTestRenderer).unmount())
  }

  test('off, reads no plan and runs no pass', async () => {
    __setEmergencyExitLiveForTests(false)
    await render(() => undefined)
    expect(loadExitPlan).not.toHaveBeenCalled()
    expect(runExitPass).not.toHaveBeenCalled()
  })

  // The control of the test above: as shipped the same render reads the plan, and finds none to follow.
  test('as shipped, reads the plan and runs no pass without one', async () => {
    await render(() => undefined)
    expect(loadExitPlan).toHaveBeenCalledWith('primary')
    expect(runExitPass).not.toHaveBeenCalled()
  })
})

// Behind the switch by construction: the relay and the key are reached only through exitPass, whose
// every entry checks it (exitPass.test.ts), and exitPass only from the route and the hook above.
test('nothing reaches the relay or the key except through what the switch holds', () => {
  const root = path.join(__dirname, '../src')
  const sources = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        return sources(full)
      }
      return /\.tsx?$/.test(entry.name) ? [full] : []
    })
  const files = [...sources(root), path.join(__dirname, '../App.tsx')]
  expect(files.length).toBeGreaterThan(100)
  const importing = (pattern: RegExp): string[] =>
    files
      .filter(file => pattern.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(root, file))
      .sort()
  expect(importing(/from '[^']*\/(chainRelay|exitFeeKey)'/)).toEqual(['wallet/exitPass.ts'])
  expect(importing(/^import \{[^}]*\} from '[^']*\/exitPass'/m)).toEqual([
    'hooks/useHomeExit.ts',
    'screens/EmergencyExitScreen.tsx',
  ])
  expect(importing(/import \{ EmergencyExitScreen \}/)).toEqual(['navigation/RootNavigator.tsx'])
})

test('the fee key stays out of the files that keep or send things', () => {
  const read = (file: string): string => fs.readFileSync(path.join(__dirname, '../src/wallet', file), 'utf8')
  const key = read('exitFeeKey.ts')
  expect(key).not.toMatch(/durableFile|react-native-fs|fetch\(/)
  expect(read('exitPlan.ts')).not.toMatch(/exitFeeKey|seed'|secretKey/)
})
