/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

async function renderApp(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />);
  });
  return tree;
}

function renderedText(tree: ReactTestRenderer.ReactTestRenderer): string {
  const strings: string[] = [];
  const walk = (node: ReactTestRenderer.ReactTestRendererJSON | string) => {
    if (typeof node === 'string') {
      strings.push(node);
      return;
    }
    node.children?.forEach(walk);
  };
  const json = tree.toJSON();
  if (json) {
    (Array.isArray(json) ? json : [json]).forEach(walk);
  }
  return strings.join(' ');
}

// The test-env locale comes from the react-native-localize mock, so any valid translation passes.
const TITLES = ['Voltz Wallet'];
const SUBTITLES = [
  'Suas chaves, seu dia a dia',
  'Your keys, every day',
  'Tus llaves, tu día a día',
];

test('renders the translated texts, not the i18n keys', async () => {
  const text = renderedText(await renderApp());

  expect(TITLES.some(title => text.includes(title))).toBe(true);
  expect(SUBTITLES.some(subtitle => text.includes(subtitle))).toBe(true);
});

test('does not leak a raw translation key on screen', async () => {
  const text = renderedText(await renderApp());

  // If i18n fails to init, react-i18next returns the key itself.
  expect(text).not.toContain('welcome.title');
  expect(text).not.toContain('welcome.subtitle');
  expect(text).not.toMatch(/\bwelcome\./);
});
