// SPDX-License-Identifier: AGPL-3.0-or-later
/** Privacy → Default reminders: what new plans (and plans you say yes to) remind you of. */
import { viewer } from '../model';
import { ReminderPicker } from '../reminderpicker';
import { defaultReminders, setDefaultReminders } from '../reminders';

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
