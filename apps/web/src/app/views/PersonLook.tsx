// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Settings → Appearance: each person's colour and marker shape. Shared, so
 * either of you can set either; the two of you can't have the same colour.
 * When the two colours could be confused with colour blindness and the
 * shapes match too, a note suggests different shapes.
 */
import {
  COLOR_NAMES,
  colorOf,
  looksAlike,
  PERSON_COLORS,
  PERSON_SHAPES,
  SHAPE_NAMES,
  setAppearance,
  shapeOf,
} from '../appearance';
import { nameOf, other, type Slot, settings, viewer } from '../model';

function ShapeMark({ shape }: { shape: string }) {
  return <span class={`shape-mark ${shape}`} aria-hidden="true" />;
}

function PersonRow({ slot }: { slot: Slot }) {
  const me = viewer.value;
  const color = colorOf(slot);
  const shape = shapeOf(slot);
  const taken = colorOf(other(slot));
  const who = slot === me ? `You (${nameOf(slot)})` : nameOf(slot);
  const missing = !settings.value.members?.[slot];
  return (
    <fieldset class="look" disabled={missing}>
      <legend class="lbl">{who}</legend>
      {missing && <p class="small muted">Once they join, you can pick theirs here too.</p>}
      <div class="swatches" role="radiogroup" aria-label={`${nameOf(slot)}’s colour`}>
        {PERSON_COLORS.map((c) => {
          const theirs = c === taken;
          return (
            <label
              key={c}
              class={`swatch${c === color ? ' on' : ''}${theirs ? ' taken' : ''}`}
              title={theirs ? `${COLOR_NAMES[c]} (${nameOf(other(slot))}’s)` : COLOR_NAMES[c]}
            >
              <input
                type="radio"
                name={`color-${slot}`}
                class="sr"
                checked={c === color}
                disabled={theirs}
                onChange={() => setAppearance(slot, { palette: c })}
              />
              <span class="chip-c" style={{ background: `var(--pal-${c})` }} aria-hidden="true" />
              <span class="sr">
                {COLOR_NAMES[c]}
                {theirs ? `, ${nameOf(other(slot))}’s colour` : ''}
              </span>
            </label>
          );
        })}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: toggle-button group (aria-pressed), labelled; fieldset/legend breaks the segmented layout */}
      <div class="seg shapes" role="group" aria-label={`${nameOf(slot)}’s shape`}>
        {PERSON_SHAPES.map((s) => (
          <button
            type="button"
            key={s}
            aria-pressed={s === shape}
            onClick={() => setAppearance(slot, { shape: s })}
          >
            <ShapeMark shape={s} />
            {SHAPE_NAMES[s]}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function PersonLook() {
  const me = viewer.value;
  const p = other(me);
  const confusable = shapeOf('a') === shapeOf('b') && looksAlike(colorOf('a'), colorOf('b'));
  return (
    <div class="stack gap">
      <p class="small muted">How each of you shows on plans and lists. You both see the same.</p>
      <PersonRow slot={me} />
      <PersonRow slot={p} />
      {confusable && (
        <p class="note" role="status">
          These two colours can look alike to people with colour blindness. Giving each of you a
          different shape keeps you easy to tell apart.
        </p>
      )}
    </div>
  );
}
