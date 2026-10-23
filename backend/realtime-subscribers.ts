import { db, ws, json, error, requireAuth } from './local-sdk';
import type { RouteHandler } from './local-sdk';
import { rateLimit, verifyDeviceAccessCode } from './security';

const SUBSCRIPTIONS_TABLE = 'entity_subscriptions';

export type SubscriptionRecord = {
  id: string;
  entity_type: string;
  entity_id: string;
  connection_id: string;
  created_at: number;
};

async function listSubscriptions(): Promise<SubscriptionRecord[]> {
  const { items } = await db.list(SUBSCRIPTIONS_TABLE, { limit: 1000 });
  return items as SubscriptionRecord[];
}

export async function removeSubscriptionsByConnection(connectionId: string) {
  const items = await listSubscriptions();
  const matchIds = items.filter(item => item.connection_id === connectionId).map(item => item.id);
  if (matchIds.length > 0) await db.delete(SUBSCRIPTIONS_TABLE, matchIds);
}

export async function addSubscription(entityType: string, entityId: string, connectionId: string) {
  await db.add(SUBSCRIPTIONS_TABLE, [{ entity_type: entityType, entity_id: entityId, connection_id: connectionId, created_at: Date.now() }]);
}

export async function removeSubscriptions(entityType: string, entityId: string, connectionId: string) {
  const items = await listSubscriptions();
  const matchIds = items.filter(item => item.entity_type === entityType && item.entity_id === entityId && item.connection_id === connectionId).map(item => item.id);
  if (matchIds.length > 0) await db.delete(SUBSCRIPTIONS_TABLE, matchIds);
}

export async function notifySubscribers(entityType: string, entityId: string, payload: unknown, excludeConnectionId?: string) {
  const items = await listSubscriptions();
  const targetConnectionIds = Array.from(new Set(items.filter(item => item.entity_type === entityType && item.entity_id === entityId).map(item => item.connection_id).filter(id => id !== excludeConnectionId)));
  if (targetConnectionIds.length === 0) return;
  await ws.send(targetConnectionIds, { v: 1, type: 'entity.update', payload: { entity_type: entityType, entity_id: entityId, data: payload } });
}

export const realtimeSubscriptionRoutes: Record<string, RouteHandler[]> = {
    'POST /api/device-agent-subscriptions': [
        rateLimit('device-subscribe-ip', 60, 60 * 1000),
        async ({ body }) => {
            const input = body as { device_id?: string; access_code?: string; connection_id?: string };
            const deviceId = String(input.device_id || '').trim();
            const accessCode = String(input.access_code || '').trim();
            const connectionId = String(input.connection_id || '').trim();
            if (!deviceId || !accessCode || !connectionId) return error('device_id, access_code, connection_id are required');
            const devices = await db.list<{ device_id?: string; access_code?: string }>('gametracker_devices', { limit: 100 });
            const device = devices.items.find(item => item.device_id === deviceId);
            if (!device || !verifyDeviceAccessCode(String(device.access_code || ''), accessCode)) return error('Invalid device credentials', 401);
            await addSubscription('device', deviceId, connectionId);
            return json({ ok: true });
        },
    ],

    'POST /api/device-agent-subscriptions/remove': [
        rateLimit('device-unsubscribe-ip', 60, 60 * 1000),
        async ({ body }) => {
            const input = body as { device_id?: string; access_code?: string; connection_id?: string };
            const deviceId = String(input.device_id || '').trim();
            const accessCode = String(input.access_code || '').trim();
            const connectionId = String(input.connection_id || '').trim();
            if (!deviceId || !accessCode || !connectionId) return error('device_id, access_code, connection_id are required');
            const devices = await db.list<{ device_id?: string; access_code?: string }>('gametracker_devices', { limit: 100 });
            const device = devices.items.find(item => item.device_id === deviceId);
            if (!device || !verifyDeviceAccessCode(String(device.access_code || ''), accessCode)) return error('Invalid device credentials', 401);
            await removeSubscriptions('device', deviceId, connectionId);
            return json({ ok: true });
        },
    ],
  'POST /api/subscriptions': [
    requireAuth(),
    async ({ body, user }) => {
      const { entity_type, entity_id, connection_id } = (body || {}) as Record<string, string>;
      if (!entity_type || !entity_id || !connection_id) return error('entity_type, entity_id, connection_id are required');
      if (entity_type !== 'device') return error('Unsupported subscription entity.', 400);
      const devices = await db.list<{ device_id?: string; owner_user_id?: string | null }>('gametracker_devices', { limit: 1000 });
      const owned = devices.items.find(item => item.device_id === entity_id && item.owner_user_id === user!.userId);
      if (!owned) return error('This PC is not paired to your account.', 403);
      await addSubscription(entity_type, entity_id, connection_id);
      return json({ ok: true });
    },
  ],
  'POST /api/subscriptions/remove': [
    requireAuth(),
    async ({ body }) => {
      const { entity_type, entity_id, connection_id } = (body || {}) as Record<string, string>;
      if (!entity_type || !entity_id || !connection_id) return error('entity_type, entity_id, connection_id are required');
      await removeSubscriptions(entity_type, entity_id, connection_id);
      return json({ ok: true });
    },
  ],
};
