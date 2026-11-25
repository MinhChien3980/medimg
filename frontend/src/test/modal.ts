import { screen } from '@testing-library/react';

/**
 * Finds an open Ant Design modal (or `modal.confirm` dialog) by its title.
 *
 * Under `NODE_ENV=test`, rc-component's `useId` returns the same id ("test-id") for every
 * component, so a dialog's `aria-labelledby` can resolve to a tooltip popup that is still in the
 * DOM, and `findByRole('dialog', { name })` then fails depending on timing. The title text itself
 * is unaffected.
 */
export async function findModal(title: string | RegExp): Promise<HTMLElement> {
  // A confirm dialog carries its title twice (`.ant-modal-title` and `.ant-modal-confirm-title`).
  const [heading] = await screen.findAllByText(title, {
    selector: '.ant-modal-title, .ant-modal-confirm-title',
  });
  const dialog = heading?.closest<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error(`The title ${String(title)} is not inside a dialog`);
  return dialog;
}
