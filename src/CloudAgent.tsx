import { useEffect } from 'react';
import { api, ws } from './local-client';

declare global {
  interface Window {
    GameTrackerCloudPost?: (url: string, payload: unknown) => Promise<unknown>;
    GameTrackerCloudRealtime?: {
      connect: (entityType: string, entityId: string, accessCode: string) => Promise<{ connectionId: string | null }>;
      drain: () => unknown[];
      disconnect: () => void;
    };
  }
}

export default function CloudAgent() {
  useEffect(() => {
    let connection: ReturnType<typeof ws.connect> | null = null;
    const queue: unknown[] = [];

    window.GameTrackerCloudPost = async (url, payload) => {
      const response = await api.post(url, payload);
      return response.data;
    };

    window.GameTrackerCloudRealtime = {
      connect: async (_entityType, entityId, accessCode) => {
        if (connection) connection.disconnect();
        connection = ws.connect({ heartbeatIntervalMs: 15000 });
        connection.onMessage(message => {
          if (message?.type === 'entity.update') queue.push(message);
        });
        await connection.ready;
        const connectionId = connection.connectionId;
        if (!connectionId) throw new Error('Realtime connection did not provide a connection id.');
        await api.post('/api/device-agent-subscriptions', {
          device_id: entityId,
          access_code: accessCode,
          connection_id: connectionId,
        });
        return { connectionId };
      },
      drain: () => queue.splice(0, queue.length),
      disconnect: () => {
        if (connection) connection.disconnect();
        connection = null;
        queue.length = 0;
      },
    };

    return () => {
      if (connection) connection.disconnect();
      connection = null;
      delete window.GameTrackerCloudPost;
      delete window.GameTrackerCloudRealtime;
    };
  }, []);

  return null;
}
