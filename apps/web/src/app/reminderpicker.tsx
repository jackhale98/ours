// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Reminders for a plan: chips for the ones set (each removable), and "Add a
 * reminder", which offers a few one-tap choices and a custom reminder:
 *   timed plans:   [amount] [minutes | hours | days | weeks] before
 *   all-day plans: [days] days before (0 = on the day) at [time]
 * Inputs are checked (range, whole numbers, duplicates, at most three) and
 * the result is previewed in words before it is added.
 */
import { useId, useState } from 'preact/hooks';
import { pushState } from '../account/notify';
import { mode } from './model';
import {
  ALL_DAY_CHOICES,
  allDayMinutes,
  MAX_DAYS_BEFORE,
  MAX_REMINDERS,
  reminderLabel,
  reminderProblem,
  TIMED_CHOICES,
  UNIT_MINUTES,
  type Unit,
} from './reminders';
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
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('15');
  const [unit, setUnit] = useState<Unit>('minutes');
  const [days, setDays] = useState('1');
  const [time, setTime] = useState('18:00');
  const [error, setError] = useState<string | null>(null);

  const full = value.length >= MAX_REMINDERS;
  const custom = (): number | null => {
    if (allDay) {
      const d = Number(days);
      if (days.trim() === '' || !Number.isInteger(d) || d < 0) return null;
      if (!/^\d{2}:\d{2}$/.test(time)) return null;
      return allDayMinutes(d, time);
    }
    const n = Number(amount);
    if (amount.trim() === '' || !Number.isInteger(n) || n < 0) return null;
    return n * UNIT_MINUTES[unit];
  };
  const candidate = custom();
  const preview =
    candidate === null
      ? allDay
        ? 'Enter how many days before (0 for the day itself) and a time.'
        : 'Enter a whole number.'
      : (reminderProblem(candidate, allDay, value) ?? reminderLabel(candidate, allDay));

  const add = (minutes: number | null) => {
    if (minutes === null) {
      setError(allDay ? 'Enter the days before and a time.' : 'Enter a whole number.');
      return;
    }
    const problem = reminderProblem(minutes, allDay, value);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    onChange([...value, minutes]);
    if (value.length + 1 >= MAX_REMINDERS) setOpen(false);
  };
  // Inside the plan form: Enter adds the reminder instead of saving the plan.
  const enterAdds = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      add(candidate);
    }
  };

  return (
    <fieldset class="field reminders">
      <legend class="lbl">{label}</legend>
      {value.length > 0 ? (
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
      ) : (
        <p class="small muted">No reminders.</p>
      )}
      {!full && (
        <button
          type="button"
          class="btn sm"
          aria-expanded={open}
          aria-controls={`${id}-p`}
          onClick={() => {
            setOpen(!open);
            setError(null);
          }}
        >
          <Icon name="plus" size={15} />
          Add a reminder
        </button>
      )}
      {open && !full && (
        <div class="rpanel" id={`${id}-p`}>
          <fieldset class="rquick">
            <legend class="sr">Quick choices</legend>
            {(allDay ? ALL_DAY_CHOICES : TIMED_CHOICES).map((m) => (
              <button
                type="button"
                key={m}
                class="chipbtn"
                disabled={value.includes(m)}
                onClick={() => add(m)}
              >
                {reminderLabel(m, allDay)}
              </button>
            ))}
          </fieldset>
          {allDay ? (
            <fieldset class="rcustom">
              <legend class="sublbl">Or your own</legend>
              <input
                class="txt rnum"
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_DAYS_BEFORE}
                step={1}
                value={days}
                aria-label="Days before (0 for the day itself)"
                onInput={(e) => {
                  setDays(e.currentTarget.value);
                  setError(null);
                }}
                onKeyDown={enterAdds}
              />
              <span>days before, at</span>
              <input
                class="txt rtime"
                type="time"
                value={time}
                aria-label="Time"
                onInput={(e) => {
                  setTime(e.currentTarget.value);
                  setError(null);
                }}
                onKeyDown={enterAdds}
              />
            </fieldset>
          ) : (
            <fieldset class="rcustom">
              <legend class="sublbl">Or your own</legend>
              <input
                class="txt rnum"
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                value={amount}
                aria-label="How long before"
                onInput={(e) => {
                  setAmount(e.currentTarget.value);
                  setError(null);
                }}
                onKeyDown={enterAdds}
              />
              <select
                class="txt runit"
                value={unit}
                aria-label="Unit"
                onChange={(e) => {
                  setUnit(e.currentTarget.value as Unit);
                  setError(null);
                }}
              >
                <option value="minutes">minutes</option>
                <option value="hours">hours</option>
                <option value="days">days</option>
                <option value="weeks">weeks</option>
              </select>
              <span>before</span>
            </fieldset>
          )}
          <p class="small muted" aria-live="polite">
            {preview}
          </p>
          {error && (
            <p class="formerr" role="alert">
              {error}
            </p>
          )}
          <div class="btnrow">
            <button type="button" class="btn sm primary" onClick={() => add(candidate)}>
              Add reminder
            </button>
            <button type="button" class="btn sm ghost" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      )}
      {hint &&
        (mode.value === 'demo' ? (
          <p class="small muted">In the demo, reminders are saved but not sent.</p>
        ) : (
          pushState.value !== 'on' && (
            <p class="small muted">
              Turn on notifications in Settings to get reminders on this device.
            </p>
          )
        ))}
    </fieldset>
  );
}
