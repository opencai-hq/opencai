// Email bodies: plain text plus a minimal HTML version of the same words.

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function passwordResetEmail({ username, link, expiresMinutes }) {
  return {
    subject: 'Reset your OpenCAI password',
    text: [
      `Hello ${username},`,
      '',
      'Someone asked to reset the password for your OpenCAI account. To choose a new password, open this link:',
      '',
      link,
      '',
      `The link works once and expires in ${expiresMinutes} minutes. You will still need your authentication code to sign in.`,
      '',
      'If you did not ask for this, you can ignore this email; your password stays the same.',
    ].join('\n'),
    html: `<p>Hello ${escapeHtml(username)},</p>
<p>Someone asked to reset the password for your OpenCAI account. To choose a new password, open this link:</p>
<p><a href="${escapeHtml(link)}">Reset your password</a></p>
<p>The link works once and expires in ${expiresMinutes} minutes. You will still need your authentication code to sign in.</p>
<p>If you did not ask for this, you can ignore this email; your password stays the same.</p>`,
  };
}

function passwordChangedEmail({ username }) {
  return {
    subject: 'Your OpenCAI password was changed',
    text: [
      `Hello ${username},`,
      '',
      'The password for your OpenCAI account was just changed, and you have been signed out everywhere.',
      '',
      'If you did not do this, contact your administrator straight away.',
    ].join('\n'),
    html: `<p>Hello ${escapeHtml(username)},</p>
<p>The password for your OpenCAI account was just changed, and you have been signed out everywhere.</p>
<p>If you did not do this, contact your administrator straight away.</p>`,
  };
}

function testEmail() {
  return {
    subject: 'OpenCAI test email',
    text: 'This is a test email from OpenCAI. Your mail settings work.',
    html: '<p>This is a test email from OpenCAI. Your mail settings work.</p>',
  };
}

module.exports = { passwordResetEmail, passwordChangedEmail, testEmail };
