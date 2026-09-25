import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { playFromGesture, useSoundSettings } from '../lib/sound.ts';
import { useAppData } from '../lib/store.tsx';
import { useTheme, type ThemeSetting } from '../lib/useTheme.ts';
import { SlidingTabs } from './transitions.tsx';

interface Row {
  tool: string;
  allow: boolean;
  rule: string;
  reason: string;
}

interface GateInfo {
  gate: { servers: Record<string, string>; allow: string[]; deny: string[]; bashExtraAllow: string[]; builtinAllow: string[] };
  recent: { t: number; run: string | null; mode: string; tool: string; input: string; allow: boolean; rule: string }[];
}

export function Settings() {
  const { config } = useAppData();
  const [gate, setGate] = useState<GateInfo | null>(null);
  const [dir, setDir] = useState('');
  const [inv, setInv] = useState<{ dir: string; rows: Row[]; mcpServers: { name: string; status: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'mcp' | 'deny'>('mcp');

  useEffect(() => {
    api.get<GateInfo>('/api/gate').then(setGate);
  }, []);

  const runInventory = async () => {
    setBusy(true);
    setError(null);
    try {
      setInv(await api.get(`/api/gate/inventory?dir=${encodeURIComponent(dir)}`));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const rows = (inv?.rows ?? []).filter((r) => (filter === 'mcp' ? r.tool.startsWith('mcp__') : filter === 'deny' ? !r.allow : true));

  return (
    <div className="settings">
      <h2>Settings</h2>
      <p className="muted">
        Config is read from <code>~/.config/agent-chat/</code> and reloads on save. The app never writes it. Claude binary: <code>{config?.claudeBin}</code>
      </p>

      <ThemeSwitch />
      <SoundSetting />

      <p>
        <button className="btn small" onClick={async () => { const r = await api.post<{ count: number }>('/api/dirs/rescan'); alert(`Directory index: ${r.count} projects found.`); }}>
          Rescan directories
        </button>
      </p>

      <h3>Agents</h3>
      <table className="gate-table">
        <tbody>
          {config?.agents.map((a) => (
            <tr key={a.name}>
              <td>
                <strong>@{a.name}</strong> {a.builtin && <span className="dd-kind">built-in</span>}
                {a.render === 'graphs' && <span className="dd-kind" data-tooltip="render: graphs — writes figures and diagrams">figures</span>}
              </td>
              <td>{a.description}</td>
              <td>
                <code>{a.builtin && !a.model ? 'Claude Code default' : (a.model ?? config.defaultModel)}</code>
              </td>
              <td>{a.tools?.length ? <code>{a.tools.join(', ')}</code> : <span className="muted">all tools</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 28 }}>Read-only gate</h3>
      <p className="muted">
        In read-only conversations every tool call passes the PreToolUse hook. Overrides live in <code>readonly.yaml</code>.
      </p>
      {gate && (
        <p>
          Server profiles: {Object.entries(gate.gate.servers).map(([k, v]) => `${k} → ${v}`).join(', ') || 'auto-detected from names'} · Extra allow:{' '}
          {gate.gate.allow.join(', ') || 'none'} · Extra deny: {gate.gate.deny.join(', ') || 'none'} · Bash extras: {gate.gate.bashExtraAllow.join(', ') || 'none'}
        </p>
      )}

      <h4>Tool inventory</h4>
      <p className="muted">Starts Claude in a directory, reads its tool list and stops it before it does any work. Use it once per repo with MCP servers.</p>
      <div className="row gap">
        <input className="inline-input" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="Directory (empty = scratch folder)" spellCheck={false} />
        <button className="btn primary" onClick={runInventory} disabled={busy}>
          {busy ? 'Reading…' : 'Run inventory'}
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {inv && (
        <>
          <p className="muted">
            {inv.dir}: {inv.rows.filter((r) => r.allow).length} allowed, {inv.rows.filter((r) => !r.allow).length} denied ·{' '}
            {(['mcp', 'deny', 'all'] as const).map((f) => (
              <button key={f} className={`link ${filter === f ? 'active-filter' : ''}`} onClick={() => setFilter(f)} style={{ marginRight: 8 }}>
                {f === 'mcp' ? 'MCP tools' : f === 'deny' ? 'denied' : 'all'}
              </button>
            ))}
          </p>
          <table className="gate-table">
            <thead>
              <tr>
                <th>Tool</th>
                <th>Read-only</th>
                <th>Rule</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.tool}>
                  <td className="tool-cell">
                    <code>{r.tool}</code>
                  </td>
                  <td>
                    <span className={`pill ${r.allow ? 'allow' : 'deny'}`}>{r.allow ? 'allow' : 'deny'}</span>
                  </td>
                  <td className="muted">{r.rule}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={3} className="muted">
                    Nothing to show.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </>
      )}

      <h4 style={{ marginTop: 24 }}>Recent gate decisions</h4>
      <table className="gate-table">
        <tbody>
          {gate?.recent.slice(0, 40).map((d, i) => (
            <tr key={i}>
              <td className="muted">{new Date(d.t).toLocaleTimeString()}</td>
              <td>
                <span className={`pill ${d.allow ? 'allow' : 'deny'}`}>{d.allow ? 'allow' : 'deny'}</span>
              </td>
              <td className="tool-cell">
                <code>{d.tool}</code>
              </td>
              <td className="muted">{d.mode}</td>
              <td className="muted">{d.rule}</td>
              <td>
                <code>{d.input.slice(0, 80)}</code>
              </td>
            </tr>
          ))}
          {!gate?.recent.length && (
            <tr>
              <td className="muted">No tool calls yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useTheme();
  return (
    <p className="row gap theme-switch">
      <span>Theme</span>
      <SlidingTabs<ThemeSetting>
        label="Theme"
        value={theme}
        onChange={setTheme}
        options={[
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
      />
      <span className="md-root">
        <span className="font-mono text-xs tracking-wide text-[var(--graph-accent)] uppercase dark:underline" data-testid="theme-sample">
          [ messages ]
        </span>
      </span>
    </p>
  );
}

function SoundSetting() {
  const [sound, setSound] = useSoundSettings();
  const preview = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Hear the new level once the slider settles, not on every step of the drag.
  const setVolume = (volume: number) => {
    setSound({ volume });
    clearTimeout(preview.current);
    preview.current = setTimeout(() => playFromGesture('reply'), 150);
  };
  useEffect(() => () => clearTimeout(preview.current), []);
  return (
    <>
      <p className="row gap sound-setting">
        <span>Sounds</span>
        <SlidingTabs<'off' | 'on'>
          label="Sounds"
          value={sound.on ? 'on' : 'off'}
          onChange={(v) => {
            setSound({ on: v === 'on' });
            if (v === 'on') playFromGesture('on');
          }}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'on', label: 'On' },
          ]}
        />
        <label className="row gap sound-volume" data-off={!sound.on || undefined}>
          <span className="muted">Volume</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(sound.volume * 100)}
            disabled={!sound.on}
            aria-label="Sound volume"
            onChange={(e) => setVolume(Number(e.target.value) / 100)}
            aria-valuetext={`${Math.round(sound.volume * 100)}%`}
          />
          <span className="sound-volume-value">{Math.round(sound.volume * 100)}%</span>
        </label>
      </p>
      <p className="muted">Short retro cues when a message is sent, an agent answers, a thread opens or something fails. Off by default when your system asks for reduced motion.</p>
    </>
  );
}
