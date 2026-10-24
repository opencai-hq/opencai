import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/AuthContext';
import { getMailSettings, sendTestEmail, updateMailSettings } from '../../lib/adminApi';
import { useToast } from '../../lib/ToastContext';
import { Field } from '../../components/Dialog';
import { AdminLayout } from './AdminLayout';

const SECURITY_OPTIONS = [
  { value: 'NONE', label: 'None' },
  { value: 'STARTTLS', label: 'STARTTLS (usually port 587)' },
  { value: 'TLS', label: 'TLS (usually port 465)' },
];

const EMPTY_FORM = {
  enabled: false,
  host: '',
  port: '587',
  security: 'STARTTLS',
  username: '',
  password: '',
  fromAddress: '',
  fromName: '',
  publicAppUrl: '',
};

function formFromSettings(settings) {
  if (!settings) return EMPTY_FORM;
  return {
    enabled: settings.enabled,
    host: settings.host || '',
    port: settings.port ? String(settings.port) : '',
    security: settings.security,
    username: settings.username || '',
    password: '', // write-only: typed to replace, left empty to keep
    fromAddress: settings.fromAddress || '',
    fromName: settings.fromName || '',
    publicAppUrl: settings.publicAppUrl || '',
  };
}

// Empty optional fields are left out so the backend keeps them unset.
function bodyFromForm(form) {
  const body = { enabled: form.enabled, security: form.security };
  for (const key of ['host', 'username', 'fromAddress', 'fromName', 'publicAppUrl']) {
    if (form[key].trim()) body[key] = form[key].trim();
  }
  if (form.port.trim()) body.port = Number(form.port);
  if (form.password) body.password = form.password;
  return body;
}

export function ManageEmail() {
  const { token } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState(null);
  const [hasPassword, setHasPassword] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    getMailSettings(token)
      .then((settings) => {
        setForm(formFromSettings(settings));
        setHasPassword(Boolean(settings?.hasPassword));
      })
      .catch((err) => {
        if (err.status === 403) setForbidden(true);
        else toast.error(err.message || 'Could not load email settings.');
      });
  }, [token]);

  const set = (key) => (e) =>
    setForm((f) => ({
      ...f,
      [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }));

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const saved = await updateMailSettings(token, bodyFromForm(form));
      setForm(formFromSettings(saved));
      setHasPassword(saved.hasPassword);
      toast.success('Email settings saved.');
    } catch (err) {
      toast.error(err.message || 'Could not save email settings.');
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(e) {
    e.preventDefault();
    setTesting(true);
    try {
      await sendTestEmail(token, testTo.trim());
      toast.success(`Test email sent to ${testTo.trim()}.`);
    } catch (err) {
      toast.error(err.message || 'Could not send the test email.');
    } finally {
      setTesting(false);
    }
  }

  return (
    <AdminLayout title="Manage Email">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-50">Manage Email</h1>
      <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
        Outgoing mail over SMTP, used to send password reset links. While it is off, people who
        forget their password are told to contact an administrator.
      </p>

      {forbidden && (
        <p className="mt-6 text-sm text-gray-600 dark:text-gray-300">
          Only the master admin can manage email settings.
        </p>
      )}

      {form && (
        <>
          <form
            onSubmit={handleSave}
            className="mt-6 space-y-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900"
          >
            <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-200">
              <input type="checkbox" checked={form.enabled} onChange={set('enabled')} />
              Send password reset emails
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="SMTP host"
                value={form.host}
                onChange={set('host')}
                required={form.enabled}
              />
              <Field
                label="Port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={set('port')}
                required={form.enabled}
              />
              <label className="block">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                  Security
                </span>
                <select
                  value={form.security}
                  onChange={set('security')}
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                >
                  {SECURITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <Field label="Username (optional)" value={form.username} onChange={set('username')} />
              <Field
                label="Password"
                type="password"
                autoComplete="new-password"
                placeholder={hasPassword ? '•••••• (saved)' : ''}
                value={form.password}
                onChange={set('password')}
              />
              <Field
                label="From address"
                type="email"
                value={form.fromAddress}
                onChange={set('fromAddress')}
                required={form.enabled}
              />
              <Field
                label="From name (optional)"
                value={form.fromName}
                onChange={set('fromName')}
              />
              <div>
                <Field
                  label="Public app URL"
                  type="url"
                  placeholder="https://opencai.example.com"
                  value={form.publicAppUrl}
                  onChange={set('publicAppUrl')}
                  required={form.enabled}
                />
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  The address people use to open OpenCAI, e.g. https://opencai.example.com. Reset
                  links point here.
                </p>
              </div>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </form>

          <form
            onSubmit={handleTest}
            className="mt-6 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900"
          >
            <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Send a test email
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              Uses the saved settings, even while sending is switched off. Save first.
            </p>
            <div className="mt-3 flex flex-wrap items-end gap-2">
              <div className="min-w-60 flex-1">
                <Field
                  label="Recipient"
                  type="email"
                  required
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                />
              </div>
              <button
                type="submit"
                disabled={testing}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
              >
                {testing ? 'Sending…' : 'Send test email'}
              </button>
            </div>
          </form>
        </>
      )}
    </AdminLayout>
  );
}
