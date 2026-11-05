// SPDX-License-Identifier: AGPL-3.0-or-later
/** Which part of Settings is showing; each has its own address (#settings/reminders). */
import { signal } from '@preact/signals';

export type SettingsSection = 'privacy' | 'reminders' | 'calendars' | 'together' | 'account';
export const SETTINGS_SECTIONS: [SettingsSection, string][] = [
  ['privacy', 'Privacy'],
  ['reminders', 'Reminders'],
  ['calendars', 'Calendars'],
  ['together', 'You two'],
  ['account', 'Account'],
];
export const isSettingsSection = (s: string): s is SettingsSection =>
  SETTINGS_SECTIONS.some(([k]) => k === s);

export const settingsSection = signal<SettingsSection>('privacy');
