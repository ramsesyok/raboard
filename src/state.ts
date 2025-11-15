import type { Memento } from 'vscode';

const LAST_SEEN_KEY = 'raBoard.lastSeenName';

type LastSeenMap = Record<string, string>;

function readState(globalState: Memento): LastSeenMap {
  return globalState.get<LastSeenMap>(LAST_SEEN_KEY, {});
}

export function getLastSeenName(globalState: Memento, room: string): string | undefined {
  const state = readState(globalState);
  return state[room];
}

export async function setLastSeenName(
  globalState: Memento,
  room: string,
  name: string | undefined,
): Promise<void> {
  const state = { ...readState(globalState) };

  if (!name) {
    delete state[room];
  } else {
    state[room] = name;
  }

  await globalState.update(LAST_SEEN_KEY, state);
}
