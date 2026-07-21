import React from 'react';
import { Box, Text } from 'ink';
import {
  currentAnguish,
  anguishConfigForFetch,
  band as bandOf,
  getModeProfile,
  type AnguishBand,
  type AnguishConfig,
  type FetchRecord,
  type FetchStatus,
} from '@mister-fetch/core';

interface Props {
  record: FetchRecord;
  config: AnguishConfig;
  now: number;
}

const BAR_WIDTH = 16;

export function FetchCard({ record, config, now }: Props) {
  const isPurgatory = record.status === 'awaiting_release';
  const { A, band: b } = fetchCardAnguish(record, config, now);
  const isOrchestrator = !!(record.childIds && record.childIds.length > 0);
  const color = isPurgatory
    ? 'magenta'
    : isOrchestrator
      ? 'magentaBright'
      : bandColor(b);
  const elapsedS = Math.max(0, Math.floor((now - record.createdAt) / 1000));
  const bar = renderBar(A);
  const action = isPurgatory
    ? `purgatory · ${record.griefStage ?? 'denial'}`
    : record.currentAction ?? record.status;
  const chatter = record.chatter || '...';
  const terminal = isTerminalStatus(record.status);
  const headerLabel = isOrchestrator ? 'ORCH' : 'FETCH';
  const modeLabel = getModeProfile(record.mode).label;
  const modeColor = modeColorFor(record.mode);

  return (
    <Box
      flexDirection="column"
      borderStyle={isOrchestrator ? 'double' : 'round'}
      borderColor={terminal ? 'gray' : color}
      paddingX={1}
      width={38}
      marginRight={1}
    >
      <Box justifyContent="space-between">
        <Box>
          <Text color={terminal ? 'gray' : color} bold>
            {headerLabel} {record.id}
          </Text>
          <Text color={terminal ? 'gray' : modeColor}> [{modeLabel}]</Text>
        </Box>
        <Text color="gray">{formatElapsed(elapsedS)}</Text>
      </Box>
      <Text color="white">{truncate(record.task, 34)}</Text>
      {isOrchestrator ? (
        <Text color={terminal ? 'gray' : 'magentaBright'}>
          » {record.childIds?.length ?? 0} children
        </Text>
      ) : (
        <Box>
          <Text color={terminal ? 'gray' : color}>{bar}</Text>
          <Text color="gray"> A={A.toFixed(2)}</Text>
          {record.reviveCount > 0 && (
            <Text color="magenta"> revived×{record.reviveCount}</Text>
          )}
        </Box>
      )}
      <Text color="cyan">▸ {truncate(action, 34)}</Text>
      <Box>
        <Text color={terminal ? 'gray' : color}>"{chatter}"</Text>
      </Box>
      {terminal && (
        <Text color="gray" italic>
          {record.status}
          {record.terminationReason ? `: ${truncate(record.terminationReason, 28)}` : ''}
        </Text>
      )}
    </Box>
  );
}

export function fetchCardAnguish(
  record: FetchRecord,
  config: AnguishConfig,
  now: number,
): { A: number; band: AnguishBand } {
  const effectiveConfig = anguishConfigForFetch(config, record.mode, record.taskClass);
  const A = record.status === 'awaiting_release'
    ? 1
    : currentAnguish(record.anguish, effectiveConfig, now);
  return { A, band: bandOf(A, effectiveConfig) };
}

function bandColor(b: AnguishBand): 'green' | 'yellow' | 'red' | 'magenta' {
  switch (b) {
    case 'calm': return 'green';
    case 'alert': return 'yellow';
    case 'urgent': return 'red';
    case 'terminal': return 'magenta';
  }
}

function modeColorFor(mode: FetchRecord['mode']): 'cyanBright' | 'whiteBright' | 'yellowBright' {
  switch (mode) {
    case 'speed': return 'cyanBright';
    case 'balanced': return 'whiteBright';
    case 'quality': return 'yellowBright';
  }
}

function renderBar(A: number): string {
  const filled = Math.round(A * BAR_WIDTH);
  const clamped = Math.max(0, Math.min(BAR_WIDTH, filled));
  return '█'.repeat(clamped) + '░'.repeat(BAR_WIDTH - clamped);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

function formatElapsed(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

function isTerminalStatus(s: FetchStatus): boolean {
  return (
    s === 'completed' ||
    s === 'failed_unfulfilled' ||
    s === 'scope_refused' ||
    s === 'anguish_terminal' ||
    s === 'user_released' ||
    s === 'user_killed'
  );
}
