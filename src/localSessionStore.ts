export type ActiveSessionCheckpoint = {
  ownerUserId: string;
  sessionId: string;
  gameId: string;
  gameName: string;
  startedAt: string;
  lastCheckpoint: string;
  currentStatus: string;
  accumulatedDurationSeconds: number;
  processId?: number;
  syncStatus: 'pending' | 'synced';
};

const DATABASE_NAME = 'gametracker-local';
const STORE_NAME = 'active-session-checkpoints';
const DATABASE_VERSION = 1;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: 'sessionId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open local session storage.'));
  });
}

export async function saveActiveCheckpoint(checkpoint: ActiveSessionCheckpoint) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(checkpoint);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Unable to save the active session checkpoint.'));
  });
  database.close();
}

export async function listActiveCheckpoints(): Promise<ActiveSessionCheckpoint[]> {
  const database = await openDatabase();
  const checkpoints = await new Promise<ActiveSessionCheckpoint[]>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result as ActiveSessionCheckpoint[]);
    request.onerror = () => reject(request.error || new Error('Unable to read active session checkpoints.'));
  });
  database.close();
  return checkpoints.sort((a, b) => b.lastCheckpoint.localeCompare(a.lastCheckpoint));
}

export async function deleteActiveCheckpoint(sessionId: string) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(sessionId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Unable to remove the active session checkpoint.'));
  });
  database.close();
}
