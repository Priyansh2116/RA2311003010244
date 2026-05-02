/**
 * Stage 6 — Standalone Priority Inbox Runner
 */

import axios from 'axios';
import * as dotenv from 'dotenv';
import { setAuthToken, Log } from '../../logging_middleware/src/index';
import { RawNotification, ScoredNotification, extractHighValueNotifications } from './services/priorityInbox';

dotenv.config();

const EVALUATION_SERVER = process.env.EVALUATION_BASE_URL ?? 'http://20.207.122.201/evaluation-service';
const MODULE_ID = 'notification_app_be';
const INBOX_SIZE = 10;

function resolveToken(): string {
  const token = process.env.AUTH_TOKEN;
  if (!token) {
    // Cannot use Log() here — token is needed to authorise the log call itself
    process.stderr.write('AUTH_TOKEN is not set. Add it to your .env file.\n');
    process.exit(1);
  }
  return token;
}

async function fetchNotificationFeed(token: string): Promise<RawNotification[]> {
  const { data } = await axios.get<{ notifications: RawNotification[] }>(
    `${EVALUATION_SERVER}/notifications`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  return data.notifications;
}

async function renderPriorityTable(entries: ScoredNotification[]): Promise<void> {
  const divider = '='.repeat(60);
  await Log('renderPriorityTable', 'INFO', MODULE_ID, divider);
  await Log('renderPriorityTable', 'INFO', MODULE_ID, `Top ${INBOX_SIZE} Priority Notifications`);
  await Log('renderPriorityTable', 'INFO', MODULE_ID, divider);

  let rank = 1;
  while (rank <= entries.length) {
    const entry = entries[rank - 1];
    const line = `#${String(rank).padStart(2, '0')}  [${entry.Type.padEnd(9)}]  score=${entry.score.toFixed(4)}  ${entry.Timestamp}  "${entry.Message}"`;
    await Log('renderPriorityTable', 'INFO', MODULE_ID, line);
    rank++;
  }

  await Log('renderPriorityTable', 'INFO', MODULE_ID, divider);
}

async function execute(): Promise<void> {
  const token = resolveToken();
  setAuthToken(token);

  await Log(
    'stage6_priority_runner.execute',
    'INFO',
    MODULE_ID,
    `Fetching notification feed to build top-${INBOX_SIZE} priority inbox`,
  );

  const notificationFeed = await fetchNotificationFeed(token);

  await Log(
    'stage6_priority_runner.execute',
    'INFO',
    MODULE_ID,
    `Feed received: ${notificationFeed.length} notifications. Applying min-heap scoring — target size: ${INBOX_SIZE}`,
  );

  const prioritisedInbox: ScoredNotification[] = extractHighValueNotifications(notificationFeed, INBOX_SIZE);

  await renderPriorityTable(prioritisedInbox);

  const topEntry = prioritisedInbox[0];
  await Log(
    'stage6_priority_runner.execute',
    'INFO',
    MODULE_ID,
    `Priority inbox complete. Top entry: type=${topEntry?.Type}, message="${topEntry?.Message}", score=${topEntry?.score.toFixed(4)}`,
  );
}

execute().catch(async (err) => {
  await Log('stage6_priority_runner.execute', 'ERROR', MODULE_ID, `Fatal error: ${err}`);
  process.exit(1);
});
