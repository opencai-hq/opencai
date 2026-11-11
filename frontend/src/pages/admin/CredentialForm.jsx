import { useState } from 'react';
import { Field } from '../../components/Dialog';
import { CSPS } from '../../lib/csp';

const emptyHost = () => ({ name: '', address: '', port: '' });
const INPUT_CLASS =
  'w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100';
// Name | address (wider) | port (fixed, 5 digits) | remove.
const HOST_ROW_CLASS = 'grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_6rem_auto] items-center gap-2';

const Help = ({ children }) =>
  children ? <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{children}</p> : null;

/** Repeatable name / address / port rows, with at least one row kept. */
function HostList({ label, hosts, onChange }) {
  const update = (index, key) => (e) =>
    onChange(hosts.map((host, i) => (i === index ? { ...host, [key]: e.target.value } : host)));
  return (
    <fieldset>
      <legend className="text-sm font-medium text-gray-700 dark:text-gray-200">{label}</legend>
      <div className="mt-1 space-y-2">
        <div
          aria-hidden="true"
          className={`${HOST_ROW_CLASS} text-xs font-medium text-gray-500 dark:text-gray-400`}
        >
          <span>Name</span>
          <span>Address (hostname or IP)</span>
          <span>Port</span>
          <span className="invisible">Remove</span>
        </div>
        {hosts.map((host, index) => (
          <div key={index} className={HOST_ROW_CLASS}>
            <input
              aria-label={`Server ${index + 1} name`}
              placeholder="web-01"
              value={host.name}
              onChange={update(index, 'name')}
              autoComplete="off"
              className={INPUT_CLASS}
            />
            <input
              aria-label={`Server ${index + 1} address`}
              placeholder="10.0.0.12 or web-01.internal"
              value={host.address}
              onChange={update(index, 'address')}
              autoComplete="off"
              className={INPUT_CLASS}
            />
            <input
              aria-label={`Server ${index + 1} port`}
              placeholder="22"
              inputMode="numeric"
              value={host.port}
              onChange={update(index, 'port')}
              autoComplete="off"
              className={INPUT_CLASS}
            />
            <button
              type="button"
              disabled={hosts.length <= 1}
              onClick={() => onChange(hosts.filter((_, i) => i !== index))}
              className="text-sm font-medium text-red-600 hover:underline disabled:no-underline disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...hosts, emptyHost()])}
        className="mt-2 text-sm font-medium text-teal-700 hover:underline dark:text-teal-400"
      >
        + Add server
      </button>
    </fieldset>
  );
}

/**
 * The credential fields of a provider (see lib/csp.js), as an in-page form.
 * Never prefilled: saved secrets are not sent back by the API. `onSubmit` gets
 * the request body and resolves true when it was saved, which clears the form.
 */
export function CredentialForm({ csp, busy, submitLabel, onSubmit }) {
  const fields = CSPS[csp]?.credentialFields ?? [];
  const [values, setValues] = useState({});
  const setValue = (name, value) => setValues((current) => ({ ...current, [name]: value }));
  const set = (name) => (e) => setValue(name, e.target.value);
  const hostsOf = (name) => values[name] ?? [emptyHost()];

  // Optional fields left blank are omitted, so the backend applies its default.
  const body = () => {
    const out = {};
    for (const field of fields) {
      const value = values[field.name];
      if (field.type === 'checkbox') {
        out[field.name] = value === true;
      } else if (field.type === 'hostList') {
        out[field.name] = hostsOf(field.name)
          .map((h) => ({ name: h.name.trim(), address: h.address.trim(), port: h.port.trim() }))
          .filter((h) => h.name || h.address || h.port)
          .map((h) => ({ ...h, port: h.port === '' ? 22 : Number(h.port) }));
      } else {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text !== '') out[field.name] = text;
      }
    }
    return out;
  };

  async function handleSubmit(e) {
    e.preventDefault();
    if (await onSubmit(body())) setValues({});
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {fields.map((field) => {
        if (field.type === 'checkbox') {
          return (
            <div key={field.name}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={values[field.name] === true}
                  onChange={(e) => setValue(field.name, e.target.checked)}
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  {field.label}
                </span>
              </label>
              <Help>{field.help}</Help>
            </div>
          );
        }
        if (field.type === 'hostList') {
          return (
            <div key={field.name}>
              <HostList
                label={field.label}
                hosts={hostsOf(field.name)}
                onChange={(hosts) => setValue(field.name, hosts)}
              />
              <Help>{field.help}</Help>
            </div>
          );
        }
        if (field.multiline) {
          return (
            <label key={field.name} className="block">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                {field.label}
              </span>
              <textarea
                required={!field.optional}
                rows={10}
                spellCheck={false}
                autoComplete="off"
                value={values[field.name] ?? ''}
                onChange={set(field.name)}
                className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-xs focus:border-teal-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
              <Help>{field.help}</Help>
            </label>
          );
        }
        return (
          <div key={field.name}>
            <Field
              label={field.label}
              type={field.secret ? 'password' : 'text'}
              required={!field.optional}
              autoComplete={field.secret ? 'new-password' : 'off'}
              value={values[field.name] ?? ''}
              onChange={set(field.name)}
            />
            <Help>{field.help}</Help>
          </div>
        );
      })}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
      >
        {busy ? 'Saving…' : submitLabel}
      </button>
    </form>
  );
}
