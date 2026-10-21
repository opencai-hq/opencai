import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PASSWORD_CHANGE_REQUIRED_EVENT } from '../lib/api';

// Sends the user to the change-password screen whenever the server says a new
// password must be chosen first (after an admin or CLI reset).
export function SessionEvents() {
  const navigate = useNavigate();

  useEffect(() => {
    const goToChangePassword = () => navigate('/change-password', { replace: true });
    window.addEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, goToChangePassword);
    return () => window.removeEventListener(PASSWORD_CHANGE_REQUIRED_EVENT, goToChangePassword);
  }, [navigate]);

  return null;
}
