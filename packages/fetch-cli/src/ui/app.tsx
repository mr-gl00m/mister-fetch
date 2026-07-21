import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { EventEmitter } from 'node:events';
import {
  isUnfinished,
  type Supervisor,
  type FetchRecord,
  type FetchStatus,
  type TriageResult,
} from '@mister-fetch/core';
import { FetchCard } from './fetch-card.js';

interface ResultEntry {
  id: string;
  task: string;
  status: FetchStatus;
  payload: unknown;
  reason?: string;
}

interface Props {
  supervisor: Supervisor;
  events: EventEmitter;
  model: string;
}

interface LogEntry {
  kind: 'info' | 'reject' | 'err';
  text: string;
}

export function App({ supervisor, events, model }: Props) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [records, setRecords] = useState<FetchRecord[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [results, setResults] = useState<ResultEntry[]>([]);
  const [now, setNow] = useState(Date.now());
  const seenTerminal = useRef<Set<string>>(new Set());

  useEffect(() => {
    supervisor.start().catch((e) =>
      setLog((l) => [...l, { kind: 'err', text: `start: ${String(e)}` }]),
    );
    const onUpd = (r: FetchRecord) => {
      setRecords(supervisor.roster());
      if (!isUnfinished(r.status) && !seenTerminal.current.has(r.id)) {
        seenTerminal.current.add(r.id);
        setResults((prev) => [
          ...prev.slice(-9),
          {
            id: r.id,
            task: r.task,
            status: r.status,
            payload: r.resultPayload,
            reason: r.terminationReason,
          },
        ]);
      }
    };
    const onRej = (data: { task: string; result: TriageResult }) => {
      setLog((l) => [
        ...l.slice(-10),
        { kind: 'reject', text: formatRejection(data.task, data.result) },
      ]);
    };
    events.on('update', onUpd);
    events.on('reject', onRej);
    return () => {
      events.off('update', onUpd);
      events.off('reject', onRej);
      supervisor.stop();
    };
  }, [supervisor, events]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      supervisor.stop();
      exit();
      return;
    }
    if (key.return) {
      const t = input.trim();
      if (t) {
        void handleCommand(t, supervisor, setLog);
        setInput('');
      }
      return;
    }
    if (key.backspace || key.delete) {
      setInput((i) => i.slice(0, -1));
      return;
    }
    if (key.escape) {
      setInput('');
      return;
    }
    // Purgatory shortcuts: when the input line is empty, uppercase R/C act on the
    // oldest Fetch awaiting release. Uppercase-only to avoid eating typed queries.
    if ((ch === 'R' || ch === 'C') && input.trim() === '' && !key.ctrl && !key.meta) {
      const p = supervisor.roster().find((r) => r.status === 'awaiting_release');
      if (p) {
        if (ch === 'R') supervisor.release(p.id);
        else supervisor.continueFetch(p.id);
        return;
      }
    }
    if (ch && !key.ctrl && !key.meta) {
      setInput((i) => i + ch);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column">
        <Box>
          <Text color="red" bold>MISTER FETCH </Text>
          <Text color="gray">— {model} — {records.length} living</Text>
        </Box>
        <Text color="gray" italic dimColor>
          fetch quest engine · single-shot · memory-ephemeral · anguish-driven
        </Text>
      </Box>
      <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
        {records.map((r) => (
          <FetchCard key={r.id} record={r} config={supervisor.config} now={now} />
        ))}
      </Box>
      {results.length > 0 && (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
        >
          <Text color="green" bold>RESULTS</Text>
          {results.slice(-5).map((res, idx) => (
            <Box key={`${res.id}-${idx}`} flexDirection="column" marginTop={1}>
              <Text>
                <Text color={res.status === 'completed' ? 'green' : 'red'} bold>
                  [{res.id}]
                </Text>
                <Text color="gray"> {res.status}</Text>
                {res.reason ? <Text color="gray"> — {res.reason}</Text> : null}
              </Text>
              <Text color="white">{truncate(res.task, 120)}</Text>
              <PayloadView payload={res.payload} />
            </Box>
          ))}
        </Box>
      )}
      {log.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {log.slice(-4).map((l, i) => (
            <Text
              key={i}
              color={l.kind === 'reject' ? 'yellow' : l.kind === 'err' ? 'red' : 'gray'}
            >
              {l.text}
            </Text>
          ))}
        </Box>
      )}
      {(() => {
        const p = records.find((r) => r.status === 'awaiting_release');
        if (!p) return null;
        return (
          <Box
            flexDirection="column"
            marginTop={1}
            borderStyle="double"
            borderColor="magenta"
            paddingX={1}
          >
            <Text color="magenta" bold>
              {p.id} IS IN PURGATORY · {p.griefStage ?? 'denial'}
            </Text>
            <Text color="white">"{p.chatter}"</Text>
            <Text color="gray">
              [R] sweet sweet release [C] keep going (or /complete {p.id} · /continue {p.id})
            </Text>
          </Box>
        );
      })()}
      <Box marginTop={1}>
        <Text color="cyan">› </Text>
        <Text>{input}</Text>
        <Text color="gray">▌</Text>
      </Box>
      <Box flexDirection="column">
        <Text color="gray" dimColor>
          task + enter · !speed !balanced !quality override · /complete ID · /kill ID · /roster · ctrl+c
        </Text>
        <Text color="gray" dimColor>
          fast path: f: find · g: grep · dg: doc-grep · open: path · w: web · (no LLM, instant)
        </Text>
      </Box>
    </Box>
  );
}

async function handleCommand(
  raw: string,
  supervisor: Supervisor,
  setLog: React.Dispatch<React.SetStateAction<LogEntry[]>>,
): Promise<void> {
  if (raw.startsWith('/complete ')) {
    const id = raw.slice('/complete '.length).trim().toUpperCase();
    const ok = supervisor.release(id);
    setLog((l) => [
      ...l.slice(-10),
      { kind: 'info', text: ok ? `released ${id}` : `no such fetch ${id}` },
    ]);
    return;
  }
  if (raw.startsWith('/kill ')) {
    const id = raw.slice('/kill '.length).trim().toUpperCase();
    const ok = supervisor.kill(id);
    setLog((l) => [
      ...l.slice(-10),
      { kind: 'info', text: ok ? `killed ${id}` : `no such fetch ${id}` },
    ]);
    return;
  }
  if (raw === '/roster') {
    const r = supervisor.roster();
    setLog((l) => [
      ...l.slice(-10),
      {
        kind: 'info',
        text: `roster: ${r.map((x) => x.id).join(', ') || '(empty)'}`,
      },
    ]);
    return;
  }
  if (raw.startsWith('/continue ')) {
    const id = raw.slice('/continue '.length).trim().toUpperCase();
    const ok = supervisor.continueFetch(id);
    setLog((l) => [
      ...l.slice(-10),
      { kind: 'info', text: ok ? `${id}: one more try` : `${id} is not in purgatory` },
    ]);
    return;
  }
  if (raw === '/purgatory') {
    const on = !supervisor.persona.requireReleaseApproval;
    supervisor.setReleaseApproval(on);
    setLog((l) => [
      ...l.slice(-10),
      {
        kind: 'info',
        text: on
          ? 'no-death mode ON — every Fetch parks instead of dying, even explain/impossible'
          : 'no-death mode OFF — attempt Fetches still park; only explain/impossible die honestly',
      },
    ]);
    return;
  }
  await supervisor.spawn(raw);
}

interface SearchHit {
  title: unknown;
  url: unknown;
  snippet?: unknown;
}

interface OrchestratorChildResult {
  id: string;
  task: string;
  status: string;
  payload: unknown;
  reason: string | null;
}

function isSearchHitArray(x: unknown): x is SearchHit[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    x.every(
      (h) =>
        h !== null &&
        typeof h === 'object' &&
        'title' in (h as object) &&
        'url' in (h as object),
    )
  );
}

function isOrchestratorPayload(x: unknown): x is OrchestratorChildResult[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    x.every(
      (p) =>
        p !== null &&
        typeof p === 'object' &&
        'id' in (p as object) &&
        'task' in (p as object) &&
        'status' in (p as object) &&
        'payload' in (p as object),
    )
  );
}

function PayloadView({ payload }: { payload: unknown }) {
  if (payload == null) {
    return <Text color="gray" italic>(no payload)</Text>;
  }
  if (isOrchestratorPayload(payload)) {
    return (
      <Box flexDirection="column">
        {payload.map((child) => (
          <Box key={child.id} flexDirection="column" marginTop={1}>
            <Text>
              <Text color="magentaBright" bold>» [{child.id}]</Text>
              <Text color={child.status === 'completed' ? 'green' : 'red'}>
                {' '}
                {child.status}
              </Text>
              {child.reason ? <Text color="gray"> — {child.reason}</Text> : null}
            </Text>
            <Text color="white">  {truncate(child.task, 100)}</Text>
            <Box marginLeft={2}>
              <PayloadView payload={child.payload} />
            </Box>
          </Box>
        ))}
      </Box>
    );
  }
  if (isSearchHitArray(payload)) {
    return (
      <Box flexDirection="column">
        {payload.slice(0, 8).map((hit, i) => (
          <Box key={i} flexDirection="column">
            <Text color="cyan">
              {i + 1}. {truncate(String(hit.title), 100)}
            </Text>
            <Text color="gray">   {truncate(String(hit.url), 100)}</Text>
            {hit.snippet ? (
              <Text color="white">   {truncate(String(hit.snippet), 160)}</Text>
            ) : null}
          </Box>
        ))}
      </Box>
    );
  }
  let s: string;
  try {
    s = JSON.stringify(payload, null, 2);
  } catch {
    s = String(payload);
  }
  const lines = s.split('\n');
  const shown = lines.slice(0, 15).join('\n');
  const more = lines.length > 15 ? '\n…' : '';
  return <Text color="white">{shown + more}</Text>;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function formatRejection(task: string, result: TriageResult): string {
  switch (result.kind) {
    case 'compound':
      return `REFUSED [compound]: "${task}" → decompose: ${result.decomposition?.join(' // ')}`;
    case 'underspecified':
      return `REFUSED [underspecified]: ${result.clarifyingQuestion ?? task}`;
    case 'refused':
      return `REFUSED: ${result.reason ?? task}`;
    default:
      return `REFUSED: ${task}`;
  }
}
