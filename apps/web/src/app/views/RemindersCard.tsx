// SPDX-License-Identifier: AGPL-3.0-or-later
/** Privacy → Default reminders: what new plans (and plans you say yes to) remind you of. */
import { nameOf, partner, updateSettings, viewer } from '../model';
import { ReminderPicker } from '../reminderpicker';
import { defaultReminders, setDefaultReminders } from '../reminders';
import { EVENING, evening } from '../select';
import { toast } from '../ui';

export function RemindersCard() {
  const me = viewer.value;
  const defs = defaultReminders(me);
  return (
    <section class="card" aria-labelledby="rem-h">
      <h2 class="h3" id="rem-h">
        Default reminders
      </h2>
      <p class="d">
        Added to plans you make and plans you say yes to. You can change them on any plan.
      </p>
      <ReminderPicker
        label="Plans with a time"
        value={defs.timed}
        allDay={false}
        hint={false}
        onChange={(timed) => setDefaultReminders(me, { ...defs, timed })}
      />
      <ReminderPicker
        label="All-day plans"
        value={defs.all_day}
        allDay={true}
        hint={false}
        onChange={(all_day) => setDefaultReminders(me, { ...defs, all_day })}
      />
    </section>
  );
}

/**
 * When an evening counts as "both free" (review 0009, P-12): shared, since
 * it's about the two of you. Shift workers' evenings start later.
 */
export function EveningCard() {
  const e = evening.value;
  const set = (start: string, end: string) => {
    if (!start || !end) return;
    if (start >= end) {
      toast('The evening has to end after it starts.');
      return;
    }
    updateSettings({ evening: { start, end } });
  };
  return (
    <section class="card" aria-labelledby="eve-h">
      <h2 class="h3" id="eve-h">
        Evenings together
      </h2>
      <p class="d">
        “Both free this evening” means neither of you has anything in this time. It’s the same for{' '}
        {nameOf(partner.value)}.
      </p>
      <div class="row2">
        <div class="field">
          <label for="eve-from">From</label>
          <input
            id="eve-from"
            class="txt"
            type="time"
            value={e.start}
            onChange={(ev) => set(ev.currentTarget.value, e.end)}
          />
        </div>
        <div class="field">
          <label for="eve-to">Until</label>
          <input
            id="eve-to"
            class="txt"
            type="time"
            value={e.end}
            onChange={(ev) => set(e.start, ev.currentTarget.value)}
          />
        </div>
      </div>
      {(e.start !== EVENING.start || e.end !== EVENING.end) && (
        <button
          type="button"
          class="linkbtn"
          onClick={() => updateSettings({ evening: { ...EVENING } })}
        >
          Back to 5 to 10 PM
        </button>
      )}
    </section>
  );
}
