import { useState } from 'react';
import { Field, FormDialog } from './Dialog';

/** Sets or clears a user's email -- where their password reset links go. Empty clears it. */
export function EditEmailDialog({ username, email, busy, onSubmit, onClose }) {
  const [value, setValue] = useState(email || '');
  return (
    <FormDialog
      title={`Email for "${username}"`}
      submitting={busy}
      onSubmit={() => onSubmit(value.trim() || null)}
      onClose={onClose}
    >
      <Field
        label="Email (optional)"
        type="email"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </FormDialog>
  );
}
