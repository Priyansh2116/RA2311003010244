import { Router, Request, Response } from 'express';
import { Log } from '../../../logging_middleware/src/index';
import {
  getAllNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  getPriorityInbox,
} from '../services/notificationService';

const router = Router();
const MODULE_ID = 'notification_app_be';

function parseIntParam(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value ?? String(fallback), 10);
  return isNaN(parsed) ? fallback : parsed;
}

async function sendServerError(res: Response, context: string, err: unknown): Promise<void> {
  await Log(context, 'ERROR', MODULE_ID, `Request failed: ${err}`);
  res.status(500).json({ error: 'An internal error occurred. Please try again.' });
}

// GET /api/v1/notifications
router.get('/', async (req: Request, res: Response) => {
  const { type, isRead, page, limit } = req.query as Record<string, string>;

  try {
    const readFilter = isRead !== undefined ? isRead === 'true' : undefined;
    const result = await getAllNotifications(
      type,
      readFilter,
      parseIntParam(page, 1),
      parseIntParam(limit, 20),
    );
    res.json(result);
  } catch (err) {
    await Log('GET /notifications', 'ERROR', MODULE_ID, `Notification listing failed: ${err}`);
    await sendServerError(res,'GET /notifications', err);
  }
});

// GET /api/v1/notifications/priority?n=10
router.get('/priority', async (req: Request, res: Response) => {
  const requestedCount = parseIntParam(req.query['n'] as string, 10);

  if (requestedCount < 1) {
    res.status(400).json({ error: 'Query parameter n must be a positive integer.' });
    return;
  }

  try {
    const topNotifications = await getPriorityInbox(requestedCount);
    res.json({ count: topNotifications.length, notifications: topNotifications });
  } catch (err) {
    await Log('GET /notifications/priority', 'ERROR', MODULE_ID, `Priority inbox build failed: ${err}`);
    await sendServerError(res,'GET /notifications/priority', err);
  }
});

// GET /api/v1/notifications/unread-count
router.get('/unread-count', async (_req: Request, res: Response) => {
  try {
    const unread = await getUnreadCount();
    res.json({ unreadCount: unread });
  } catch (err) {
    await Log('GET /notifications/unread-count', 'ERROR', MODULE_ID, `Unread count retrieval failed: ${err}`);
    await sendServerError(res,'GET /notifications/unread-count', err);
  }
});

// PATCH /api/v1/notifications/read-all
// Declared before /:id/read so Express doesn't treat "read-all" as an ID segment
router.patch('/read-all', async (_req: Request, res: Response) => {
  try {
    const affectedCount = await markAllAsRead();
    res.json({ message: `${affectedCount} notifications marked as read.` });
  } catch (err) {
    await Log('PATCH /notifications/read-all', 'ERROR', MODULE_ID, `Bulk read-mark failed: ${err}`);
    await sendServerError(res,'PATCH /notifications/read-all', err);
  }
});

// PATCH /api/v1/notifications/:id/read
router.patch('/:id/read', async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    await Log('PATCH /notifications/:id/read', 'INFO', MODULE_ID, `Read receipt requested for ${id}`);
    await markAsRead(id);
    res.json({ message: 'Notification marked as read.', id });
  } catch (err) {
    await Log('PATCH /notifications/:id/read', 'ERROR', MODULE_ID, `Read-mark failed for ${id}: ${err}`);
    await sendServerError(res,`PATCH /notifications/${id}/read`, err);
  }
});

export default router;
