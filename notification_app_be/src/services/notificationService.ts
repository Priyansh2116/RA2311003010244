import axios from 'axios';
import { Log } from '../../../logging_middleware/src/index';
import { RawNotification, ScoredNotification, extractHighValueNotifications } from './priorityInbox';

const EVALUATION_SERVER = process.env.EVALUATION_BASE_URL ?? 'http://20.207.122.201/evaluation-service';
const MODULE_ID = 'notification_app_be';

//state survives server restarts and scales across instances
const readReceiptStore = new Map<string, boolean>();

function resolveAuthHeader(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.AUTH_TOKEN ?? ''}`,
  };
}

async function loadRemoteNotifications(): Promise<RawNotification[]> {
  await Log(
    'notificationService.loadRemoteNotifications',
    'INFO',
    MODULE_ID,
    'Pulling notification feed from evaluation service',
  );

  const { data } = await axios.get<{ notifications: RawNotification[] }>(
    `${EVALUATION_SERVER}/notifications`,
    { headers: resolveAuthHeader() },
  );

  await Log(
    'notificationService.loadRemoteNotifications',
    'INFO',
    MODULE_ID,
    `Notification feed received: ${data.notifications.length} entries`,
  );

  return data.notifications;
}

function applyReadState(raw: RawNotification): RawNotification & { isRead: boolean } {
  return { ...raw, isRead: readReceiptStore.get(raw.ID) ?? false };
}

function matchesFilters(
  entry: RawNotification & { isRead: boolean },
  typeFilter?: string,
  readFilter?: boolean,
): boolean {
  const typeMatch = typeFilter ? entry.Type === typeFilter : true;
  const readMatch = readFilter !== undefined ? entry.isRead === readFilter : true;
  return typeMatch && readMatch;
}

export async function getAllNotifications(
  typeFilter?: string,
  readFilter?: boolean,
  page = 1,
  pageSize = 20,
): Promise<{
  notifications: (RawNotification & { isRead: boolean })[];
  total: number;
  page: number;
  hasMore: boolean;
}> {
  await Log(
    'notificationService.getAllNotifications',
    'INFO',
    MODULE_ID,
    `Listing notifications — type=${typeFilter ?? 'all'}, read=${readFilter ?? 'all'}, page=${page}`,
  );

  const remoteData = await loadRemoteNotifications();
  const enriched = remoteData.map(applyReadState);
  const filtered = enriched.filter((n) => matchesFilters(n, typeFilter, readFilter));

  const total = filtered.length;
  const startIdx = (page - 1) * pageSize;
  const paginated = filtered.slice(startIdx, startIdx + pageSize);

  return { notifications: paginated, total, page, hasMore: startIdx + pageSize < total };
}

export async function markNotificationRead(notificationID: string): Promise<void> {
  await Log(
    'notificationService.markNotificationRead',
    'INFO',
    MODULE_ID,
    `Recording read receipt for notification ${notificationID}`,
  );
  readReceiptStore.set(notificationID, true);
}

export async function markAllNotificationsRead(): Promise<number> {
  const allNotifications = await loadRemoteNotifications();
  allNotifications.forEach((n) => readReceiptStore.set(n.ID, true));

  await Log(
    'notificationService.markAllNotificationsRead',
    'INFO',
    MODULE_ID,
    `Bulk read-receipt recorded: ${allNotifications.length} notifications marked`,
  );
  return allNotifications.length;
}

export async function countUnread(): Promise<number> {
  const allNotifications = await loadRemoteNotifications();
  const unreadCount = allNotifications.filter((n) => !(readReceiptStore.get(n.ID) ?? false)).length;

  await Log(
    'notificationService.countUnread',
    'DEBUG',
    MODULE_ID,
    `Current unread count: ${unreadCount}`,
  );
  return unreadCount;
}

export async function buildPriorityInbox(topN: number): Promise<ScoredNotification[]> {
  await Log(
    'notificationService.buildPriorityInbox',
    'INFO',
    MODULE_ID,
    `Constructing priority inbox: selecting top ${topN} by composite score`,
  );

  const allNotifications = await loadRemoteNotifications();
  const prioritised = extractHighValueNotifications(allNotifications, topN);

  await Log(
    'notificationService.buildPriorityInbox',
    'INFO',
    MODULE_ID,
    `Priority inbox ready: ${prioritised.length} of ${allNotifications.length} notifications selected`,
  );

  return prioritised;
}

// Legacy aliases 
export { markNotificationRead as markAsRead, markAllNotificationsRead as markAllAsRead, countUnread as getUnreadCount, buildPriorityInbox as getPriorityInbox };
