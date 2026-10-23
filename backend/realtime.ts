import { removeSubscriptionsByConnection } from './realtime-subscribers';

export const realtime = async (event: any) => {
  let message: any = {};
  try {
    message = JSON.parse(event.body || '{}');
  } catch {
    message = {};
  }
  if (message.type === 'system.disconnected' && message.payload?.connection_id) {
    await removeSubscriptionsByConnection(message.payload.connection_id);
  }
  return { statusCode: 200 };
};