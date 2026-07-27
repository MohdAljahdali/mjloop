import { submitLabel } from './button.js'

/** The one shared surface component. Everything else composes it. */
export function card({ title, body }) {
  return {
    tag: 'section',
    style: {
      background: 'var(--color-surface)',
      padding: 'var(--space-2)',
      borderRadius: 'var(--radius-sm)',
      fontFamily: 'var(--font-sans)',
    },
    children: [title, body, submitLabel()],
  }
}
