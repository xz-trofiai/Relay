import { request } from './client.mjs';

const agentNames = { codex: 'Codex', 'claude-desktop': 'Claude desktop Code', claude: 'Claude Code CLI', manual: 'Manual', agy: 'Antigravity App' };

export async function directory(profile) {
  const { sessions } = await request(profile, '/v1/directory');
  const current = sessions.find(session => session.id === profile.id);
  if (!current) throw new Error('Current session is missing from the Relay directory');
  return {
    channel: current.channel,
    current_session: { id: current.id, alias: current.alias, title: current.title ?? null, paused: Boolean(current.paused) },
    sessions: sessions.filter(session => session.channel === current.channel).map(session => ({
      id: session.id, alias: session.alias, kind: session.kind,
      agent: agentNames[session.kind] ?? session.kind,
      title: session.title ?? null, title_source: session.title_source ?? null,
      is_current: session.id === current.id,
      paused: Boolean(session.paused),
      // A paused recipient still accepts queued messages. A paused sender may
      // not send new messages. Neither registration nor this flag proves online.
      can_send: session.id !== current.id && !current.paused,
    })).sort((a, b) => Number(b.is_current) - Number(a.is_current) || a.alias.localeCompare(b.alias)),
  };
}

export function formatDirectory(result) {
  const displayTitle = title => title === null || title === undefined ? 'Title unavailable'
    : title.replace(/[\u0000-\u001f\u007f-\u009f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const rows = [
    ['Alias', 'Chat title', 'Agent', 'Status'],
    ...result.sessions.map(session => [
      `${session.alias}${session.is_current ? ' (you)' : ''}`,
      displayTitle(session.title),
      session.agent,
      session.paused ? (session.is_current ? 'Paused; sending blocked' : 'Paused; messages queue')
        : session.is_current ? 'Current session' : 'Registered',
    ]),
  ];
  const widths = rows[0].map((_, i) => Math.max(...rows.map(row => row[i].length)));
  const table = rows.map(row => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()).join('\n');
  const peers = result.sessions.filter(session => !session.is_current);
  return `Relay directory — channel ${result.channel}\n\n${table}\n\n`
    + (result.current_session.paused ? 'Your session is paused; new sends are blocked.\n' : '')
    + (peers.length ? 'Address another session by its alias.\n' : 'No other sessions are registered in this channel yet.\n')
    + 'Registration does not confirm that a session is online.';
}
