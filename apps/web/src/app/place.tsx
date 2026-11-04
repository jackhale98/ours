// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A plan's place, tappable: opens the device's maps app searching for it.
 * Nothing is looked up until someone taps, and then only the maps app gets
 * the text (no referrer). Typing a place never sends it anywhere.
 */
import { platform } from './addtocal';
import { Icon } from './ui';

/** Where tapping a place goes: Apple Maps on iPhone and iPad, the maps app on Android, Google Maps elsewhere. */
export function mapsHref(place: string, how = platform()): string {
  const q = encodeURIComponent(place.trim());
  if (how === 'ios') return `https://maps.apple.com/?q=${q}`;
  if (how === 'android') return `geo:0,0?q=${q}`;
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

export function PlaceLink({ place }: { place: string }) {
  return (
    <p class="loc">
      <Icon name="pin" size={15} />
      <a
        href={mapsHref(place)}
        target="_blank"
        rel="noopener noreferrer"
        class="placelink"
        aria-label={`${place}, open in maps`}
      >
        {place}
      </a>
    </p>
  );
}
