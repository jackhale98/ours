// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which list item's sheet is open. Kept apart from the sheet itself
 * (itemsheet.tsx), so the views that open it don't load the sheet, its
 * reminder picker and the rest at start-up: the sheet loads when it opens.
 */
import { signal } from '@preact/signals';

export const itemSheet = signal<string | null>(null);
