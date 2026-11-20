import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text } from 'react-native';
import i18n from 'i18next';
import '../src/i18n';
import { ErrorBoundary } from '../src/components/ErrorBoundary';

// A throw inside render is the whole point of this component, and React logs it to console.error on
// the way past. Silenced per test so a passing run does not print a stack that reads like a failure.
let noise: jest.SpyInstance;
beforeEach(() => {
  noise = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  noise.mockRestore();
});

// Wrapped in act, as every render in this suite is, because without it the renderer reports itself
// unmounted the moment anything is read off it.
function render(node: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(node);
  });
  return tree;
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).map(node => {
    const child = node.props.children;
    return typeof child === 'string' ? child : '';
  });
}

function press(tree: ReactTestRenderer.ReactTestRenderer): void {
  const target = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).length > 0);
  if (!target) {
    throw new Error('no pressable found on the recovery screen');
  }
  target.props.onPress();
}

function Bomb({ live }: { live: boolean }): React.JSX.Element {
  if (live) {
    throw new Error('exploded during render');
  }
  return <Text>the app</Text>;
}

it('draws the app when nothing throws', () => {
  const tree = render(
    <ErrorBoundary>
      <Bomb live={false} />
    </ErrorBoundary>,
  );
  expect(texts(tree)).toContain('the app');
});

it('catches a render throw instead of letting the tree unmount to nothing', () => {
  // Without a boundary React discards the whole tree, which on a phone is a blank screen with no way
  // back. This asserts the screen still says something.
  const tree = render(
    <ErrorBoundary>
      <Bomb live={true} />
    </ErrorBoundary>,
  );
  const shown = texts(tree);
  expect(shown).not.toContain('the app');
  expect(shown.join(' ').length).toBeGreaterThan(0);
});

it('says the money is untouched, which is the only thing worth reading here', () => {
  // The wallet key lives in the Keychain, not in React state, so a render crash cannot reach it. A
  // crash screen that does not say so leaves a self-custody user assuming the worst.
  const tree = render(
    <ErrorBoundary>
      <Bomb live={true} />
    </ErrorBoundary>,
  );
  expect(texts(tree).join(' ')).toContain(i18n.t('errors.crashBody'));
});

it('offers a way out, and the way out re-renders the children', () => {
  let live = true;
  function Flaky(): React.JSX.Element {
    if (live) {
      throw new Error('transient');
    }
    return <Text>recovered</Text>;
  }
  const tree = render(
    <ErrorBoundary>
      <Flaky />
    </ErrorBoundary>,
  );
  expect(texts(tree)).not.toContain('recovered');

  live = false;
  ReactTestRenderer.act(() => {
    // Located by its onPress rather than by type, because Pressable renders as an inner View in RN
    // 0.86 and findByType never sees it.
    press(tree);
  });
  expect(texts(tree)).toContain('recovered');
});

it('still says something when i18n is the thing that broke', async () => {
  // The boundary renders after a failure somewhere in the tree, and i18n is in that tree. One that
  // throws while drawing its own message leaves exactly the blank screen it exists to prevent, so the
  // English literals are a floor rather than an intention.
  const broken = jest.spyOn(i18n, 't').mockImplementation(() => {
    throw new Error('i18n is gone');
  });
  try {
    const tree = render(
      <ErrorBoundary>
        <Bomb live={true} />
      </ErrorBoundary>,
    );
    expect(texts(tree).join(' ')).toContain('Something broke');
  } finally {
    broken.mockRestore();
  }
});

it('follows the language, so the fallback is a floor and not the copy', async () => {
  await i18n.changeLanguage('pt-BR');
  try {
    const tree = render(
      <ErrorBoundary>
        <Bomb live={true} />
      </ErrorBoundary>,
    );
    const shown = texts(tree).join(' ');
    expect(shown).toContain('frase de recuperação');
    expect(shown).not.toContain('Something broke');
  } finally {
    await i18n.changeLanguage('en-US');
  }
});
