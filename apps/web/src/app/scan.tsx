// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * "Scan a code": reads a device link's QR code with this device's camera,
 * inside the app. Needed on an iPhone or iPad, where the camera opens links
 * in Safari, never in an app added to the Home Screen (the two keep separate
 * storage). The camera runs only while this is open, frames stay on the
 * device, and the reader (BarcodeDetector where the browser has one, else
 * jsQR, loaded only now) gets nothing else. The text found goes through the
 * same checks as a pasted link.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { type PastedLink, parseLink } from './pastelink';
import { CloseButton, Sheet, toast } from './ui';

interface Detector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

/** One reader for camera frames: the browser's, if it reads QR codes, else jsQR. */
async function makeReader(): Promise<(video: HTMLVideoElement) => Promise<string | null>> {
  const Ctor = (
    globalThis as {
      BarcodeDetector?: DetectorCtor & { getSupportedFormats?: () => Promise<string[]> };
    }
  ).BarcodeDetector;
  const formats: string[] = (await Ctor?.getSupportedFormats?.().catch(() => [])) ?? [];
  if (Ctor && formats.includes('qr_code')) {
    const d = new Ctor({ formats: ['qr_code'] });
    return async (video) => (await d.detect(video).catch(() => []))[0]?.rawValue ?? null;
  }
  const jsQR = (await import('jsqr')).default;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return async (video) => {
    if (!ctx || !video.videoWidth) return null;
    // Small frames read fast enough and a link's code is large on screen.
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

function Scanner({
  accept,
  onLink,
  onClose,
}: {
  accept: PastedLink['kind'][];
  onLink: (link: PastedLink) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState('Starting the camera…');
  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let warned = false;
    const stop = () => {
      stopped = true;
      for (const t of stream?.getTracks() ?? []) t.stop();
    };
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
      } catch {
        setStatus(
          'The camera isn’t available. Allow it for Ours in your settings, or paste the link instead.',
        );
        return;
      }
      if (stopped || !video.current) return stop();
      video.current.srcObject = stream;
      await video.current.play().catch(() => {});
      setStatus('Point the camera at the code on your other device.');
      const read = await makeReader();
      while (!stopped) {
        const text = video.current ? await read(video.current) : null;
        if (text) {
          const link = parseLink(text);
          if (link && accept.includes(link.kind)) {
            stop();
            onLink(link);
            return;
          }
          if (!warned) {
            warned = true;
            setStatus('That code isn’t a link from Ours. Scan the one under “Link a new device”.');
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    return stop;
  }, []);
  return (
    <Sheet labelledBy="scan-h" onClose={onClose}>
      <div class="sheet-form">
        <div class="sh-head">
          <h2 id="scan-h">Scan a code</h2>
          <CloseButton onClose={onClose} />
        </div>
        <video ref={video} class="scanview" playsInline muted />
        <p class="d small" role="status">
          {status}
        </p>
      </div>
    </Sheet>
  );
}

/** A button that scans a link's QR code, if this device has a camera. */
export function ScanLink({
  label,
  accept,
  onLink,
}: {
  label: string;
  accept: PastedLink['kind'][];
  onLink: (link: PastedLink) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  if (!navigator.mediaDevices?.getUserMedia) return null;
  return (
    <>
      <button type="button" class="btn" onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <Scanner
          accept={accept}
          onClose={() => setOpen(false)}
          onLink={(link) => {
            setOpen(false);
            void Promise.resolve(onLink(link)).catch((err: unknown) =>
              toast(err instanceof Error ? err.message : 'That link couldn’t be used.'),
            );
          }}
        />
      )}
    </>
  );
}
