import { Navigate, useNavigate } from 'react-router-dom';
import logo from '../assets/opencai-logo.png';
import { useAuth } from '../lib/AuthContext';
import { ChangePasswordForm } from '../components/ChangePasswordForm';

// Shown after an admin or CLI reset: the server refuses everything else until
// the user picks a new password.
export function ChangePasswordPage() {
  const { token } = useAuth();
  const navigate = useNavigate();

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-100 p-4 dark:bg-gray-950">
      <div className="w-full max-w-sm rounded-3xl bg-white p-8 shadow-sm dark:bg-gray-900">
        <img src={logo} alt="OpenCAI" className="h-8 w-auto" />
        <h1 className="mt-6 text-2xl font-bold text-gray-900 dark:text-gray-50">
          Set a new password
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          An administrator reset your password. Enter the temporary password you were given, then
          choose a new one.
        </p>
        <ChangePasswordForm
          currentLabel="Temporary password"
          submitLabel="Set password"
          onChanged={() => navigate('/dashboard', { replace: true })}
        />
      </div>
    </div>
  );
}
