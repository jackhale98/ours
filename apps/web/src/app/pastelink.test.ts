// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseLink } from './pastelink';

const token = 'A'.repeat(43);
const fragment = `0190a6c8-7a3e-7cc2-9b1d-000000000001.${'A'.repeat(43)}`;

describe('pasted links', () => {
  it('reads sign-in links, whole or as their fragment, with stray spaces', () => {
    expect(parseLink(`https://ourplanner.app/#signin=${token}`)).toEqual({ kind: 'signin', token });
    expect(parseLink(`  #signin=${token}\n`)).toEqual({ kind: 'signin', token });
  });

  it('reads invite and device links', () => {
    expect(parseLink(`https://ourplanner.app/join/#${fragment}`)).toEqual({
      kind: 'join',
      fragment,
    });
    expect(parseLink(fragment)).toEqual({ kind: 'join', fragment });
  });

  it('refuses anything else', () => {
    for (const bad of [
      '',
      'https://ourplanner.app/',
      `#signin=${token.slice(1)}`,
      'hello',
      '#a.b',
    ]) {
      expect(parseLink(bad), bad).toBeNull();
    }
  });
});
