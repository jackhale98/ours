// SPDX-License-Identifier: AGPL-3.0-or-later
/** Up to three reminders: each shown as a removable chip, plus "Add a reminder". */
import { useId } from 'preact/hooks';
import { pushState } from '../account/notify';
import { mode } from './model';
import { ALL_DAY_CHOICES, MAX_REMINDERS, reminderLabel, TIMED_CHOICES } from './reminders';
import { Icon } from './ui';

export function ReminderPicker({
  value,
  allDay,
  onChange,
  label = 'Remind me',
  hint = true,
}: {
  value: number[];
  allDay: boolean;
  onChange: (next: number[]) => void;
  label?: string;
  hint?: boolean;
}) {
  const id = useId();
  const choices = (allDay ? ALL_DAY_CHOICES : TIMED_CHOICES).filter((m) => !value.includes(m));
  return (
    <div class="field reminders">
      <label for={id}>{label}</label>
      {value.length > 0 && (
        <ul class="rchips" aria-label="Reminders">
          {value.map((m) => (
            <li key={m}>
              <span>{reminderLabel(m, allDay)}</span>
              <button
                type="button"
                class="iconbtn"
                aria-label={`Remove reminder: ${reminderLabel(m, allDay)}`}
                onClick={() => onChange(value.filter((x) => x !== m))}
              >
                <Icon name="x" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length < MAX_REMINDERS ? (
        <select
          id={id}
          class="txt"
          value=""
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v) onChange([...value, Number(v)]);
            e.currentTarget.value = '';
          }}
        >
          <option value="">{value.length ? 'Add another reminder…' : 'No reminder'}</option>
          {choices.map((m) => (
            <option key={m} value={String(m)}>
              {reminderLabel(m, allDay)}
            </option>
          ))}
        </select>
      ) : (
        <p class="small muted" id={id}>
          Up to {MAX_REMINDERS} reminders.
        </p>
      )}
      {hint &&
        (mode.value === 'demo' ? (
          <p class="small muted">In the demo, reminders are saved but not sent.</p>
        ) : (
          pushState.value !== 'on' && (
            <p class="small muted">
              Turn on notifications in Privacy to get reminders on this device.
            </p>
          )
        ))}
    </div>
  );
}
