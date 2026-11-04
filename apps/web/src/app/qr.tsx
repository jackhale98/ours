// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * QR codes for device links: drawn here from the link (uqr), never sent
 * anywhere, and scanned by the new device's camera or by "Scan a code" in
 * the app (scan.tsx). Always dark on white, whatever the theme, so cameras
 * read it.
 */
import { useMemo } from 'preact/hooks';
import { encode } from 'uqr';

export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(text, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) => {
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { size: qr.size, path: d };
  }, [text]);
  return (
    <svg
      class="qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shape-rendering="crispEdges"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
