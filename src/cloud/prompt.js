import readline from 'node:readline';
import { Writable } from 'node:stream';
import blessed from 'blessed';
import '../wide-chars.js';
import { runListMenu, interactive, menuListRoom } from '../menu.js';
import { renderMenuMarkup, menuRuleLabel } from '../ui.js';
import { CloudApiError } from './api.js';
import { cloudWebUrl } from './config.js';

function rule(label, width) {
  const prefix = `─ ${label} `;
  const dashes = '─'.repeat(Math.max(0, width - prefix.length));
  return `${prefix}${dashes}`;
}

// Field rows lined up by hardcoded label padding, which only ever matched the
// English labels: `логин:` and `пароль:` differ in length, so the brackets
// landed in different columns. Pad from the labels actually being drawn.
function fieldRows(rows) {
  const widest = Math.max(...rows.map(([label]) => [...label].length));
  return rows.map(([label, field]) => {
    const gap = ' '.repeat(widest - [...label].length + 1);
    return `  ${label}:${gap}[${field}]`;
  });
}

// The active field is drawn inverse with padding spaces inside the highlight;
// the inactive one needs the same spaces, or switching fields shifts the text
// by a column.
function fieldMarkup(active, value, placeholder) {
  if (active) return `{inverse} ${blessed.escape(value || ' ')} {/inverse}`;
  return value ? ` ${blessed.escape(value)} ` : ` {grey-fg}[${placeholder}]{/grey-fg} `;
}

const CODES = new Map([
  ['bad_credentials', 'cloud.badCredentials'],
  ['bad_recovery_key', 'cloud.badRecoveryKey'],
  ['invalid_login', 'cloud.badLogin'],
  ['invalid_password', 'cloud.badPassword'],
  ['invalid_name', 'cloud.badName'],
  ['login_taken', 'cloud.loginTaken'],
  ['too_many_attempts', 'cloud.tooManyAttempts'],
  ['unreachable', 'cloud.unreachable'],
  ['unknown_token', 'cloud.tokenExpired'],
  ['invalid_invite', 'cloud.invalidInvite'],
  // Minting somebody else's link is the deployment owner's privilege, and the
  // two official contacts never get one at all; both refusals are sentences.
  ['forbidden', 'cloud.inviteForbidden'],
  ['official_invite', 'cloud.inviteOfficial'],
  ['invite_not_found', 'cloud.inviteNotFound'],
  ['self_invite', 'cloud.selfInvite'],
  // `/add` answers these four; `invalid_login` and `unknown_user` above are the
  // same codes it shares with the rest of the routes.
  ['self_request', 'cloud.selfRequest'],
  ['official_request', 'cloud.requestOfficial'],
  ['blocked', 'cloud.requestBlocked'],
  ['request_limit', 'cloud.requestLimit'],
  ['not_friends', 'cloud.notFriends'],
  ['self_block', 'cloud.selfBlock'],
  ['unknown_user', 'cloud.unknownUser'],
  // `/remove` answers these three; without a line of their own they would reach
  // the screen as the raw code, which is exactly what this map exists to stop.
  ['official_contact', 'remove.official'],
  ['self_remove', 'remove.self'],
  ['peer_not_found', 'cloud.peerUnknown'],
  ['extra_password_required', 'cloud.extraPasswordRequired'],
]);

export function describeApiError(error, t) {
  const key = CODES.get(error?.code);
  if (key) return t(key);
  return t('cloud.serverSaid', { code: String(error?.code ?? 'error') });
}

// Fallback line reading for non-blessed streams/tests
export function askLine(question, { input = process.stdin, output = process.stdout } = {}) {
  output.write(question);
  if (!interactive(input, output) || typeof input.setRawMode !== 'function') {
    const rl = readline.createInterface({ input, output });
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
        rl.close();
      };
      rl.on('line', (raw) => done(String(raw).trim()));
      rl.once('close', () => done(''));
    });
  }
  return new Promise((resolve) => {
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    let line = '';
    const onData = (chunk) => {
      const str = String(chunk);
      for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (char === '\r' || char === '\n') {
          cleanup();
          output.write('\n');
          resolve(line.trim());
          return;
        }
        if (char === '\u0003') {
          cleanup();
          output.write('\n');
          resolve('');
          return;
        }
        if (char === '\u0008' || char === '\u007f') {
          if (line.length > 0) {
            line = line.slice(0, -1);
            output.write('\b \b');
          }
          continue;
        }
        if (char === '\u001b') continue;
        if (char >= ' ') {
          line += char;
          output.write(char);
        }
      }
    };
    function cleanup() {
      input.removeListener('data', onData);
      if (input.setRawMode) input.setRawMode(wasRaw ?? false);
    }
    input.on('data', onData);
  });
}

export function askSecret(question, { input = process.stdin, output = process.stdout } = {}) {
  output.write(question);
  if (!interactive(input, output) || typeof input.setRawMode !== 'function') {
    const muted = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
    const rl = readline.createInterface({ input, output: muted });
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
        rl.close();
      };
      rl.on('line', (raw) => {
        output.write('\n');
        done(String(raw));
      });
      rl.once('close', () => done(''));
    });
  }
  return new Promise((resolve) => {
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    let secret = '';
    const onData = (chunk) => {
      const str = String(chunk);
      for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (char === '\r' || char === '\n') {
          cleanup();
          output.write('\n');
          resolve(secret);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          output.write('\n');
          resolve('');
          return;
        }
        if (char === '\u0008' || char === '\u007f') {
          if (secret.length > 0) secret = secret.slice(0, -1);
          continue;
        }
        if (char === '\u001b') continue;
        if (char >= ' ') secret += char;
      }
    };
    function cleanup() {
      input.removeListener('data', onData);
      if (input.setRawMode) input.setRawMode(wasRaw ?? false);
    }
    input.on('data', onData);
  });
}

// Single-screen unified sign-in dialog with recovery support
export function signIn({
  api, t, defaultName = '', themed = true, pubKey = null,
  input = process.stdin, output = process.stdout,
}) {
  if (!interactive(input, output)) {
    output.write(`${t('cloud.needTerminal')}\n`);
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const screen = blessed.screen({
      smartCSR: true,
      title: 'tailchat',
      fullUnicode: true,
      input,
      output,
    });

    const frame = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      border: 'line',
      style: themed ? { border: { fg: 'green' } } : { border: { fg: 'white' } },
    });

    const titleBox = blessed.box({
      parent: frame, top: 1, left: 1, right: 1, height: 1, tags: true,
    });

    const bodyBox = blessed.box({
      parent: frame, top: 3, left: 2, right: 2, height: 10, tags: true,
    });

    const statusBox = blessed.box({
      parent: frame, top: 13, left: 2, right: 2, height: 2, tags: true,
    });

    const hintBox = blessed.box({
      parent: frame, bottom: 1, left: 1, right: 1, height: 1, tags: true,
    });

    let mode = 'login'; // 'login' | 'register' | 'recover'
    let currentField = 0;
    let login = String(defaultName || '').trim();
    let displayName = '';
    let password = '';
    let passwordConfirm = '';
    let recoveryKey = '';
    let extraPassword = '';
    // Set once the server answers `extra_password_required` for this login
    // attempt: the form then grows a third field and resubmits with it.
    let needExtraPassword = false;
    let statusText = '';
    let statusKind = ''; // 'error' | 'busy' | 'success'
    let busy = false;
    let finished = false;

    const finish = (value) => {
      if (finished) return;
      finished = true;
      screen.program.removeListener('keypress', onKeypress);
      screen.destroy();
      resolve(value);
    };

    const render = () => {
      const width = Math.max(1, Number(screen.width) - 4);
      const isNarrow = width < 45;
      const title = isNarrow ? 'TAILCHAT' : 'TAILCHAT / CLOUD';
      titleBox.setContent(themed
        ? `{green-fg}{bold}${blessed.escape(rule(title, width))}{/bold}{/green-fg}`
        : blessed.escape(rule(title, width)));

      let tabsLine = '';
      if (isNarrow) {
        const curTab = mode === 'login'
          ? t('cloud.tabLogin')
          : (mode === 'register' ? t('cloud.tabRegister') : t('cloud.tabRecover'));
        tabsLine = themed
          ? `  {green-fg}◄{/green-fg} {bold}{white-bg}{black-fg} ${curTab} {/black-fg}{/white-bg}{/bold} {green-fg}►{/green-fg}`
          : `  ◄ [ ${curTab} ] ►`;
      } else {
        const tab1 = mode === 'login'
          ? `{bold}{white-bg}{black-fg} [ ${t('cloud.tabLogin')} ] {/black-fg}{/white-bg}{/bold}`
          : `[ ${t('cloud.tabLogin')} ]`;
        const tab2 = mode === 'register'
          ? `{bold}{white-bg}{black-fg} [ ${t('cloud.tabRegister')} ] {/black-fg}{/white-bg}{/bold}`
          : `[ ${t('cloud.tabRegister')} ]`;
        const tab3 = mode === 'recover'
          ? `{bold}{white-bg}{black-fg} [ ${t('cloud.tabRecover')} ] {/black-fg}{/white-bg}{/bold}`
          : `[ ${t('cloud.tabRecover')} ]`;
        tabsLine = `  ${tab1}   ${tab2}   ${tab3}`;
      }

      const labelOf = (key, fallback) => (t(key).replace(/:.*/, '') || fallback);
      const hintOf = (key) => t(key).replace(/:.*/, '').trim();

      const loginLabel = labelOf('cloud.loginPrompt', 'Login');
      const passLabel = labelOf('cloud.passwordPrompt', 'Password');
      const loginField = fieldMarkup(currentField === 0, login, hintOf('cloud.loginPrompt'));
      const passMask = '•'.repeat(password.length);

      let bodyLines = [tabsLine, ''];

      if (mode === 'register') {
        const nameField = fieldMarkup(currentField === 1, displayName, login || 'name');
        const passField = fieldMarkup(currentField === 2, passMask, hintOf('cloud.passwordPrompt'));
        const passConfField = fieldMarkup(
          currentField === 3,
          '•'.repeat(passwordConfirm.length),
          hintOf('cloud.passwordConfirmPrompt'),
        );

        bodyLines.push(
          `  {bold}${t('cloud.titleRegister')}{/bold}`,
          '',
          ...fieldRows([
            [loginLabel, loginField],
            [labelOf('cloud.namePrompt', 'Name'), nameField],
            [passLabel, passField],
            [labelOf('cloud.passwordConfirmPrompt', 'Confirm'), passConfField],
          ]),
          isNarrow ? '' : `  {grey-fg}${t('cloud.passwordAdvise')}{/grey-fg}`,
        );
      } else if (mode === 'recover') {
        const recField = fieldMarkup(currentField === 1, recoveryKey, hintOf('cloud.recoveryKeyPrompt'));
        const passField = fieldMarkup(currentField === 2, passMask, hintOf('cloud.passwordPrompt'));

        bodyLines.push(
          `  {bold}${t('cloud.titleRecover')}{/bold}`,
          '',
          ...fieldRows([
            [loginLabel, loginField],
            [labelOf('cloud.recoveryKeyPrompt', 'Key'), recField],
            [passLabel, passField],
          ]),
        );
      } else {
        const passField = fieldMarkup(currentField === 1, passMask, hintOf('cloud.passwordPrompt'));
        const rows = [
          [loginLabel, loginField],
          [passLabel, passField],
        ];
        if (needExtraPassword) {
          const extraField = fieldMarkup(
            currentField === 2,
            '•'.repeat(extraPassword.length),
            hintOf('cloud.extraPasswordPrompt'),
          );
          rows.push([labelOf('cloud.extraPasswordPrompt', 'Extra password'), extraField]);
        }

        bodyLines.push(
          `  {bold}${t('cloud.titleLogin')}{/bold}`,
          '',
          ...fieldRows(rows),
          isNarrow ? '' : `  {grey-fg}${t('cloud.loginHint')}{/grey-fg}`,
        );
      }
      bodyBox.setContent(bodyLines.filter((l, idx) => idx < 2 || l !== '').join('\n'));

      if (statusKind === 'error') {
        statusBox.setContent(`{red-fg}✗ ${blessed.escape(statusText)}{/red-fg}`);
      } else if (statusKind === 'busy') {
        statusBox.setContent(`{yellow-fg}● ${blessed.escape(statusText)}{/yellow-fg}`);
      } else if (statusKind === 'success') {
        statusBox.setContent(`{green-fg}✓ ${blessed.escape(statusText)}{/green-fg}`);
      } else if (statusKind === 'info') {
        statusBox.setContent(`{cyan-fg}i ${blessed.escape(statusText)}{/cyan-fg}`);
      } else {
        statusBox.setContent('');
      }

      const navHint = isNarrow
        ? '[←/→] Mode  [Tab] Next  [Enter] Ok'
        : (t('cloud.navHint') || '[←/→] Mode   [Tab/↑↓] Field   [Enter] Submit   [Esc] Exit');
      hintBox.setContent(themed
        ? `{green-fg}${blessed.escape(navHint)}{/green-fg}`
        : blessed.escape(navHint));

      screen.render();
    };

    const submit = async () => {
      if (busy) return;
      const cleanLogin = login.trim().toLowerCase();
      if (!cleanLogin) {
        statusText = t('cloud.badLogin');
        statusKind = 'error';
        currentField = 0;
        render();
        return;
      }

      if (mode === 'register') {
        if (!password) {
          statusText = t('cloud.badPassword');
          statusKind = 'error';
          currentField = 2;
          render();
          return;
        }
        if (password !== passwordConfirm) {
          statusText = t('cloud.passwordMismatch');
          statusKind = 'error';
          currentField = 3;
          render();
          return;
        }

        busy = true;
        statusText = 'Creating account…';
        statusKind = 'busy';
        render();

        try {
          const out = await api.register({
            login: cleanLogin,
            password,
            name: displayName.trim() || cleanLogin,
            pubKey,
          });

          if (out.recoveryKey) {
            bodyBox.hide();
            statusBox.hide();
            titleBox.setContent(themed
              ? `{bold}{green-fg}${blessed.escape('TAILCHAT / CLOUD — RECOVERY KEY')}{/green-fg}{/bold}`
              : blessed.escape('TAILCHAT / CLOUD — RECOVERY KEY'));

            const modal = blessed.box({
              parent: frame,
              top: 2,
              left: 2,
              right: 2,
              bottom: 3,
              border: 'line',
              tags: true,
              style: themed
                ? { border: { fg: 'green' } }
                : { border: { fg: 'white' } },
            });

            const title = t('cloud.recoveryTitle');
            const sub = t('cloud.recoverySubtitle');
            const hint = t('cloud.recoveryHint');
            const lines = [
              '',
              themed ? `  {bold}{green-fg}${blessed.escape(title)}{/green-fg}{/bold}` : `  ${title}`,
              '',
              themed ? `    {bold}{white-bg}{black-fg}  ${out.recoveryKey}  {/black-fg}{/white-bg}{/bold}` : `    [ ${out.recoveryKey} ]`,
              '',
              `  ${sub}`,
              `  ${hint}`,
              '',
            ];
            modal.setContent(lines.join('\n'));
            hintBox.setContent(themed
              ? `{bold}{green-fg}${blessed.escape(t('cloud.recoveryContinue'))}{/green-fg}{/bold}`
              : blessed.escape(t('cloud.recoveryContinue')));
            screen.render();

            setTimeout(() => {
              const onAck = (ch, key) => {
                if (key?.name === 'enter' || key?.name === 'return' || key?.name === 'space' || key?.name === 'escape') {
                  screen.program.removeListener('keypress', onAck);
                  finish(out);
                }
              };
              screen.program.on('keypress', onAck);
            }, 300);
            return;
          }

          statusText = t('cloud.signedIn', { name: out.user.name || out.user.login });
          statusKind = 'success';
          render();
          setTimeout(() => finish(out), 350);
        } catch (error) {
          busy = false;
          statusText = error instanceof CloudApiError ? describeApiError(error, t) : (error?.message || 'Registration failed');
          statusKind = 'error';
          render();
        }
        return;
      }

      if (mode === 'recover') {
        const cleanKey = recoveryKey.trim();
        if (!cleanKey) {
          statusText = t('cloud.badRecoveryKey');
          statusKind = 'error';
          currentField = 1;
          render();
          return;
        }
        if (!password) {
          statusText = t('cloud.badPassword');
          statusKind = 'error';
          currentField = 2;
          render();
          return;
        }

        busy = true;
        statusText = 'Recovering account…';
        statusKind = 'busy';
        render();

        try {
          const out = await api.recover({ login: cleanLogin, recoveryKey: cleanKey, newPassword: password });
          statusText = t('cloud.signedIn', { name: out.user.name || out.user.login });
          statusKind = 'success';
          render();
          setTimeout(() => finish(out), 350);
        } catch (error) {
          busy = false;
          statusText = error instanceof CloudApiError ? describeApiError(error, t) : (error?.message || 'Recovery failed');
          statusKind = 'error';
          render();
        }
        return;
      }

      // mode === 'login'
      if (!password) {
        statusText = t('cloud.badPassword');
        statusKind = 'error';
        currentField = 1;
        render();
        return;
      }
      if (needExtraPassword && !extraPassword) {
        statusText = t('cloud.badExtraPassword');
        statusKind = 'error';
        currentField = 2;
        render();
        return;
      }

      busy = true;
      statusText = 'Connecting…';
      statusKind = 'busy';
      render();

      try {
        const out = await api.login({
          login: cleanLogin, password, pubKey,
          extraPassword: needExtraPassword ? extraPassword : undefined,
        });
        statusText = t('cloud.signedIn', { name: out.user.name || out.user.login });
        statusKind = 'success';
        render();
        setTimeout(() => finish(out), 350);
      } catch (error) {
        busy = false;
        if (error instanceof CloudApiError && error.code === 'extra_password_required') {
          // Correct primary password, but this account needs the second one
          // too: grow the form instead of reporting a failure.
          needExtraPassword = true;
          extraPassword = '';
          currentField = 2;
          statusText = t('cloud.extraPasswordRequired');
          statusKind = 'info';
        } else if (error instanceof CloudApiError) {
          statusText = describeApiError(error, t);
          statusKind = 'error';
        } else {
          statusText = error?.message || 'Connection failed';
          statusKind = 'error';
        }
        render();
      }
    };

    const onKeypress = (ch, key) => {
      if (busy) return;
      const name = key?.name;
      if (name === 'escape' || key?.full === 'C-c') return finish(null);
      const modes = ['login', 'register', 'recover'];
      if (name === 'left') {
        const idx = modes.indexOf(mode);
        mode = modes[(idx - 1 + modes.length) % modes.length];
        currentField = 0;
        needExtraPassword = false;
        extraPassword = '';
        statusText = '';
        render();
        return;
      }
      if (name === 'right' || key?.full === 'C-t' || key?.full === 'C-r') {
        const idx = modes.indexOf(mode);
        mode = modes[(idx + 1) % modes.length];
        currentField = 0;
        needExtraPassword = false;
        extraPassword = '';
        statusText = '';
        render();
        return;
      }
      if (name === 'f1') {
        mode = 'login';
        currentField = 0;
        needExtraPassword = false;
        extraPassword = '';
        statusText = '';
        render();
        return;
      }
      if (name === 'f2') {
        mode = 'register';
        currentField = 0;
        needExtraPassword = false;
        extraPassword = '';
        statusText = '';
        render();
        return;
      }
      if (name === 'f3') {
        mode = 'recover';
        currentField = 0;
        needExtraPassword = false;
        extraPassword = '';
        statusText = '';
        render();
        return;
      }
      const maxField = mode === 'register' ? 3 : (mode === 'recover' ? 2 : (needExtraPassword ? 2 : 1));
      if (name === 'tab' || name === 'down') {
        currentField = (currentField + 1) % (maxField + 1);
        statusText = '';
        render();
        return;
      }
      if (name === 'up') {
        currentField = (currentField - 1 + maxField + 1) % (maxField + 1);
        statusText = '';
        render();
        return;
      }
      if (name === 'enter' || name === 'return') {
        if (currentField < maxField) {
          // If on an empty field, step to next field unless already on password
          currentField += 1;
          render();
          return;
        }
        submit();
        return;
      }
      if (name === 'backspace') {
        if (currentField === 0) {
          if (login.length > 0) login = login.slice(0, -1);
        } else if (mode === 'register') {
          if (currentField === 1) {
            if (displayName.length > 0) displayName = displayName.slice(0, -1);
          } else if (currentField === 2) {
            if (password.length > 0) password = password.slice(0, -1);
          } else if (currentField === 3) {
            if (passwordConfirm.length > 0) passwordConfirm = passwordConfirm.slice(0, -1);
          }
        } else if (mode === 'recover') {
          if (currentField === 1) {
            if (recoveryKey.length > 0) recoveryKey = recoveryKey.slice(0, -1);
          } else if (currentField === 2) {
            if (password.length > 0) password = password.slice(0, -1);
          }
        } else if (needExtraPassword && currentField === 2) {
          if (extraPassword.length > 0) extraPassword = extraPassword.slice(0, -1);
        } else {
          if (password.length > 0) password = password.slice(0, -1);
        }
        statusText = '';
        render();
        return;
      }
      if (typeof ch === 'string' && ch >= ' ') {
        if (currentField === 0) {
          if (login.length < 32) login += ch;
        } else if (mode === 'register') {
          if (currentField === 1) {
            if (displayName.length < 24) displayName += ch;
          } else if (currentField === 2) {
            if (password.length < 200) password += ch;
          } else if (currentField === 3) {
            if (passwordConfirm.length < 200) passwordConfirm += ch;
          }
        } else if (mode === 'recover') {
          if (currentField === 1) {
            if (recoveryKey.length < 64) recoveryKey += ch;
          } else if (currentField === 2) {
            if (password.length < 200) password += ch;
          }
        } else if (needExtraPassword && currentField === 2) {
          if (extraPassword.length < 200) extraPassword += ch;
        } else {
          if (password.length < 200) password += ch;
        }
        statusText = '';
        render();
      }
    };

    screen.program.on('keypress', onKeypress);
    render();
  });
}

export function describeLastSeen(lastSeen, t, now = Date.now()) {
  if (!Number.isFinite(lastSeen) || lastSeen <= 0) return t('cloud.seenNever');
  const minutes = Math.max(0, Math.round((now - lastSeen) / 60_000));
  if (minutes < 1) return t('cloud.seenJustNow');
  if (minutes < 60) return t('cloud.seenMinutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t('cloud.seenHours', { count: hours });
  return t('cloud.seenDays', { count: Math.round(hours / 24) });
}

export function peerRows(users, t, now = Date.now()) {
  return users.map((user) => ({
    name: user.name || user.login,
    help: user.official
      ? t('cloud.officialAccount')
      : (user.online ? t('cloud.statusHere') : describeLastSeen(user.lastSeen, t, now)),
    value: user.login,
  }));
}

// Single-screen interactive peer selection and friend management
export async function pickPeer({
  api, users, t, themed = true, now = Date.now(),
  input = process.stdin, output = process.stdout,
}) {
  if (!interactive(input, output)) {
    for (const row of peerRows(users, t, now)) {
      output.write(`  ${row.value} — ${row.name} (${row.help})\n`);
    }
    return null;
  }

  let currentUsers = [...users];

  return new Promise((resolve) => {
    const screen = blessed.screen({
      smartCSR: true,
      title: 'tailchat',
      fullUnicode: true,
      input,
      output,
    });

    const frame = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      border: 'line',
      style: themed ? { border: { fg: 'green' } } : { border: { fg: 'white' } },
    });

    const titleBox = blessed.box({ parent: frame, top: 1, left: 1, right: 1, height: 1, tags: true });
    const list = blessed.box({ parent: frame, top: 3, left: 1, right: 1, height: 10, tags: true });
    const listRoom = () => menuListRoom(screen.height);
    const hint = blessed.box({ parent: frame, bottom: 1, left: 1, right: 1, height: 1, tags: true });

    let view = 'roster'; // 'roster' | 'invite_menu' | 'show_invite' | 'enter_invite'
    let index = 0;
    let offset = 0;
    let inviteMenuIndex = 0;
    // The link, not the code: this is the string a person copies off the screen
    // and sends on, and a bare 64-hex code is not something a recipient can act
    // on. Everything that accepts one accepts the link built from the same
    // server (the CLI's own `parseInviteCode`, every other client's too).
    let inviteLink = '';
    let inviteInput = '';
    let statusText = '';
    let statusKind = ''; // 'error' | 'success' | 'busy'
    let busy = false;
    let finished = false;
    let viewOpenedAt = Date.now();

    const finish = (value) => {
      if (finished) return;
      finished = true;
      screen.program.removeListener('keypress', onKeypress);
      screen.destroy();
      resolve(value);
    };

    const getRosterRows = () => {
      const rows = peerRows(currentUsers, t, Date.now());
      rows.push({
        name: t('cloud.addFriend'),
        help: t('cloud.addFriendHelp'),
        value: '__invite__',
      });
      return rows;
    };

    const getInviteMenuRows = () => [
      { name: t('cloud.myInvite'), help: t('cloud.myInviteHelp'), value: 'show' },
      { name: t('cloud.enterInvite'), help: t('cloud.enterInviteHelp'), value: 'accept' },
      { name: t('cloud.back'), help: '', value: 'back' },
    ];

    const render = () => {
      const width = Math.max(1, Number(screen.width) - 4);

      if (view === 'roster') {
        const rows = getRosterRows();
        const visible = Math.min(listRoom(), rows.length);
        if (index < offset) offset = index;
        else if (index >= offset + visible) offset = index - visible + 1;
        offset = Math.min(Math.max(0, offset), Math.max(0, rows.length - visible));
        const shown = rows.slice(offset, offset + visible);
        const hidden = rows.length - shown.length;
        list.height = Math.max(1, shown.length);

        const label = menuRuleLabel({ index, total: rows.length, shown: shown.length, word: t('cloud.pickTitle') });
        titleBox.setContent(themed
          ? `{green-fg}{bold}${blessed.escape(rule(label, width))}{/bold}{/green-fg}`
          : blessed.escape(rule(label, width)));

        const nameWidth = Math.max(1, ...rows.map(({ name }) => String(name).length));
        list.setContent(renderMenuMarkup({
          shown, hidden, chosenIndex: index - offset, width, themed, nameWidth,
        }));

        hint.setContent(themed
          ? `{green-fg}${blessed.escape(t('pick.keysHint'))}{/green-fg}`
          : blessed.escape(t('pick.keysHint')));
      } else if (view === 'invite_menu') {
        const rows = getInviteMenuRows();
        list.height = rows.length;
        const title = t('cloud.inviteTitle');
        titleBox.setContent(themed
          ? `{green-fg}{bold}${blessed.escape(rule(title, width))}{/bold}{/green-fg}`
          : blessed.escape(rule(title, width)));

        const nameWidth = Math.max(1, ...rows.map(({ name }) => String(name).length));
        list.setContent(renderMenuMarkup({
          shown: rows, hidden: 0, chosenIndex: inviteMenuIndex, width, themed, nameWidth,
        }));

        hint.setContent(themed
          ? `{green-fg}${blessed.escape('[↑↓/1-3] Choose   [Enter] Select   [Esc] Back')}{/green-fg}`
          : blessed.escape('[↑↓/1-3] Choose   [Enter] Select   [Esc] Back'));
      } else if (view === 'show_invite') {
        list.height = 7;
        const title = t('cloud.myInvite');
        titleBox.setContent(themed
          ? `{green-fg}{bold}${blessed.escape(rule(title, width))}{/bold}{/green-fg}`
          : blessed.escape(rule(title, width)));

        const lines = [
          `{bold}${t('cloud.inviteCreated')}{/bold}`,
          '',
          `  {cyan-fg}${blessed.escape(inviteLink)}{/cyan-fg}`,
          '',
          `{grey-fg}${t('cloud.myInviteHelp')}{/grey-fg}`,
        ];
        list.setContent(lines.join('\n'));

        hint.setContent(themed
          ? `{green-fg}${blessed.escape('[Enter/Esc] Back to friends')}{/green-fg}`
          : blessed.escape('[Enter/Esc] Back to friends'));
      } else if (view === 'enter_invite') {
        list.height = 7;
        const title = t('cloud.enterInvite');
        titleBox.setContent(themed
          ? `{green-fg}{bold}${blessed.escape(rule(title, width))}{/bold}{/green-fg}`
          : blessed.escape(rule(title, width)));

        const lines = [
          `{bold}${t('cloud.enterInviteHelp')}{/bold}`,
          '',
          `  ${t('cloud.invitePrompt').replace(/:.*/, '') || 'Code'}: [ {inverse} ${blessed.escape(inviteInput || ' ')} {/inverse} ]`,
          '',
        ];
        if (statusKind === 'error') {
          lines.push(`  {red-fg}✗ ${blessed.escape(statusText)}{/red-fg}`);
        } else if (statusKind === 'busy') {
          lines.push(`  {yellow-fg}● ${blessed.escape(statusText)}{/yellow-fg}`);
        } else if (statusKind === 'success') {
          lines.push(`  {green-fg}✓ ${blessed.escape(statusText)}{/green-fg}`);
        }
        list.setContent(lines.join('\n'));

        hint.setContent(themed
          ? `{green-fg}${blessed.escape('[Enter] Submit   [Esc] Back')}{/green-fg}`
          : blessed.escape('[Enter] Submit   [Esc] Back'));
      }

      screen.render();
    };

    const onKeypress = async (ch, key) => {
      if (busy) return;
      const nowMs = Date.now();
      if (nowMs - viewOpenedAt < 80) return; // Prevent key bounce

      const name = key?.name;

      if (view === 'roster') {
        const rows = getRosterRows();
        if (name === 'up') {
          index = Math.max(0, index - 1);
          render();
          return;
        }
        if (name === 'down') {
          index = Math.min(rows.length - 1, index + 1);
          render();
          return;
        }
        if (typeof ch === 'string' && /^[1-9]$/.test(ch)) {
          const at = Number(ch) - 1;
          if (at >= 0 && at < rows.length) {
            index = at;
            const row = rows[index];
            if (row?.value === '__invite__') {
              view = 'invite_menu';
              inviteMenuIndex = 0;
              viewOpenedAt = Date.now();
              render();
            } else {
              finish(row?.value ?? null);
            }
          }
          return;
        }
        if (name === 'enter' || name === 'return') {
          const row = rows[index];
          if (row?.value === '__invite__') {
            view = 'invite_menu';
            inviteMenuIndex = 0;
            viewOpenedAt = Date.now();
            render();
          } else {
            finish(row?.value ?? null);
          }
          return;
        }
        if (name === 'escape' || key?.full === 'C-c') {
          finish(null);
          return;
        }
      } else if (view === 'invite_menu') {
        const rows = getInviteMenuRows();
        if (name === 'up') {
          inviteMenuIndex = Math.max(0, inviteMenuIndex - 1);
          render();
          return;
        }
        if (name === 'down') {
          inviteMenuIndex = Math.min(rows.length - 1, inviteMenuIndex + 1);
          render();
          return;
        }
        if (name === 'escape' || key?.full === 'C-c') {
          view = 'roster';
          viewOpenedAt = Date.now();
          render();
          return;
        }
        if (typeof ch === 'string' && /^[1-3]$/.test(ch)) {
          inviteMenuIndex = Number(ch) - 1;
        }
        if (name === 'enter' || name === 'return' || (typeof ch === 'string' && /^[1-3]$/.test(ch))) {
          const choice = rows[inviteMenuIndex]?.value;
          if (choice === 'back') {
            view = 'roster';
            viewOpenedAt = Date.now();
            render();
            return;
          }
          if (choice === 'show') {
            busy = true;
            try {
              const code = await api.createInvite();
              inviteLink = api.server ? `${cloudWebUrl(api.server)}?invite=${code}` : code;
              view = 'show_invite';
              viewOpenedAt = Date.now();
            } catch (err) {
              statusText = describeApiError(err, t);
            }
            busy = false;
            render();
            return;
          }
          if (choice === 'accept') {
            view = 'enter_invite';
            inviteInput = '';
            statusText = '';
            statusKind = '';
            viewOpenedAt = Date.now();
            render();
            return;
          }
        }
      } else if (view === 'show_invite') {
        if (name === 'enter' || name === 'return' || name === 'escape' || key?.full === 'C-c') {
          view = 'roster';
          viewOpenedAt = Date.now();
          render();
        }
      } else if (view === 'enter_invite') {
        if (name === 'escape' || key?.full === 'C-c') {
          view = 'roster';
          viewOpenedAt = Date.now();
          render();
          return;
        }
        if (name === 'backspace') {
          if (inviteInput.length > 0) inviteInput = inviteInput.slice(0, -1);
          statusText = '';
          render();
          return;
        }
        if (name === 'enter' || name === 'return') {
          const code = inviteInput.trim();
          if (!code) {
            statusText = t('cloud.invalidInvite');
            statusKind = 'error';
            render();
            return;
          }
          busy = true;
          statusText = 'Verifying invite…';
          statusKind = 'busy';
          render();
          try {
            const friend = await api.acceptInvite(code);
            statusText = t('cloud.friendAdded', { name: friend.name || friend.login });
            statusKind = 'success';
            try {
              currentUsers = await api.users();
            } catch {}
            render();
            setTimeout(() => {
              busy = false;
              view = 'roster';
              viewOpenedAt = Date.now();
              render();
            }, 1000);
          } catch (err) {
            busy = false;
            statusText = describeApiError(err, t);
            statusKind = 'error';
            render();
          }
          return;
        }
        if (typeof ch === 'string' && ch >= ' ') {
          if (inviteInput.length < 128) inviteInput += ch;
          statusText = '';
          render();
        }
      }
    };

    screen.program.on('keypress', onKeypress);
    render();
  });
}
