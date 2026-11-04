// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId } from 'preact/hooks';

/**
 * Two interlocking rings, one per person. Each passes over the other once,
 * so neither sits on top: what they make together is "ours". The weave is a
 * mask, not a background-coloured stroke, so the mark works on any surface.
 */
export function LogoMark({ size = 28 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={Math.round((size * 2) / 3)} viewBox="8 16 48 32" aria-hidden="true">
      <mask id={id} maskUnits="userSpaceOnUse" x="8" y="16" width="48" height="32">
        <rect x="8" y="16" width="48" height="32" fill="#fff" />
        <path d="M28.45 19.78A13 13 0 0 1 34.78 24.73" fill="none" stroke="#000" stroke-width="9" />
      </mask>
      <circle class="logo-a" cx="24" cy="32" r="13" />
      <circle class="logo-b" cx="40" cy="32" r="13" mask={`url(#${id})`} />
    </svg>
  );
}
