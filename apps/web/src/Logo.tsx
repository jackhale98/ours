// SPDX-License-Identifier: AGPL-3.0-or-later
/** Two overlapping circles: one per person, "ours" where they meet. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={Math.round(size * 0.62)} viewBox="0 0 34 21" aria-hidden="true">
      <circle class="logo-a" cx="10.5" cy="10.5" r="9" />
      <circle class="logo-b" cx="23.5" cy="10.5" r="9" />
    </svg>
  );
}
