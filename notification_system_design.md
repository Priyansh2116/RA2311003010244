# Notification System Design — AffordMed Campus Notifications

---

## Stage 1

### API Design

The platform supports three notification categories — **Placement**, **Result**, **Event** — and must deliver them in real-time when a student is active.

#### Core REST Endpoints

All routes are prefixed `/api/v1`. Authenticated routes require `Authorization: Bearer <token>`.

---

**List notifications for the current user**

```
GET /api/v1/notifications
Authorization: Bearer <token>
```

Query parameters:

| Param    | Type    | Default | Description                          |
|----------|---------|---------|--------------------------------------|
| `type`   | string  | —       | Filter by `Placement`, `Result`, `Event` |
| `isRead` | boolean | —       | Filter by read/unread status         |
| `page`   | integer | 1       | Page number                          |
| `limit`  | integer | 20      | Items per page                       |

Response `200`:
```json
{
  "notifications": [
    {
      "id": "d146095a-0d86-4a34-9e69-3900a14576bc",
      "type": "Placement",
      "message": "CSX Corporation hiring",
      "isRead": false,
      "createdAt": "2026-04-22T17:51:18Z"
    }
  ],
  "total": 142,
  "page": 1,
  "hasMore": true
}
```

---

**Get a single notification**

```
GET /api/v1/notifications/:id
Authorization: Bearer <token>
```

Response `200`:
```json
{
  "id": "d146095a-0d86-4a34-9e69-3900a14576bc",
  "type": "Placement",
  "message": "CSX Corporation hiring",
  "isRead": false,
  "createdAt": "2026-04-22T17:51:18Z"
}
```

---

**Mark a notification as read**

```
PATCH /api/v1/notifications/:id/read
Authorization: Bearer <token>
```

Response `200`:
```json
{ "message": "Notification marked as read", "id": "d146095a-..." }
```

---

**Mark all notifications as read**

```
PATCH /api/v1/notifications/read-all
Authorization: Bearer <token>
```

Response `200`:
```json
{ "message": "Marked 142 notifications as read" }
```

---

**Get unread count (for badge display)**

```
GET /api/v1/notifications/unread-count
Authorization: Bearer <token>
```

Response `200`:
```json
{ "unreadCount": 7 }
```

---

**Create a notification (admin)**

```
POST /api/v1/notifications
Authorization: Bearer <admin_token>
Content-Type: application/json
```

Request:
```json
{
  "type": "Placement",
  "message": "Amazon SDE internship drive on 28th April",
  "studentIDs": ["1042", "1043"]
}
```

Response `201`:
```json
{
  "notificationID": "uuid",
  "recipientCount": 2,
  "queuedAt": "2026-04-22T18:00:00Z"
}
```

---

**Bulk notify all students (admin)**

```
POST /api/v1/notifications/bulk
Authorization: Bearer <admin_token>
Content-Type: application/json
```

Request:
```json
{
  "type": "Placement",
  "message": "Notify All — Amazon drive",
  "targetAll": true
}
```

Response `202` (accepted, processed asynchronously):
```json
{
  "jobID": "job-uuid",
  "status": "queued",
  "estimatedRecipients": 50000
}
```

---

#### Real-Time Mechanism

Real-time delivery uses **WebSockets**. Clients connect once after login and receive push frames when new notifications are created.

```
WebSocket: ws://api.campus.com/ws/notifications
Authorization header passed during the HTTP upgrade handshake.
```

Server-sent frame:
```json
{
  "event": "new_notification",
  "data": {
    "id": "uuid",
    "type": "Placement",
    "message": "Amazon SDE drive",
    "createdAt": "2026-04-22T18:00:01Z"
  }
}
```

For environments where WebSockets are unavailable, **Server-Sent Events** (SSE) provide a fallback:
```
GET /api/v1/notifications/stream
Authorization: Bearer <token>
Accept: text/event-stream
```

---

## Stage 2

### Database Design

#### Choice: PostgreSQL

PostgreSQL is recommended over a NoSQL alternative for this use case because:

- Notifications have a fixed, well-known schema — no need for schema-on-read flexibility.
- Strong ACID guarantees ensure a notification is never lost between the insert and the read.
- Enum types enforce valid notification categories at the DB layer.
- Mature ecosystem for indexing, partitioning, and query optimisation — important as volume grows.

#### Schema

```sql
CREATE TYPE notification_type AS ENUM ('Event', 'Result', 'Placement');

CREATE TABLE students (
  id           SERIAL       PRIMARY KEY,
  student_id   VARCHAR(50)  UNIQUE NOT NULL,
  email        VARCHAR(255) UNIQUE NOT NULL,
  name         VARCHAR(255) NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE notifications (
  id                UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        INTEGER          NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  notification_type notification_type NOT NULL,
  message           TEXT             NOT NULL,
  is_read           BOOLEAN          NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- Index to speed up the most common query: unread notifications for a student
CREATE INDEX idx_notifications_student_unread
  ON notifications (student_id, is_read, created_at DESC)
  WHERE is_read = FALSE;
```

#### Problems at Scale & Solutions

| Problem | Solution |
|---|---|
| Full table scans on 5M rows | Compound + partial indexes (see above) |
| Hot row contention on `is_read` updates | Batch `UPDATE` with a read-receipts side table; mark async |
| Storage growth | Partition by `created_at` (monthly ranges); archive notifications older than 6 months to cold storage |
| Single-node write bottleneck | Add a read replica; route `SELECT` queries to the replica |
| Connection saturation | Use PgBouncer connection pooling |

#### Representative Queries

Fetch all unread notifications for a student, newest first:
```sql
SELECT id, notification_type, message, created_at
FROM   notifications
WHERE  student_id = 1042
  AND  is_read = FALSE
ORDER  BY created_at DESC
LIMIT  20;
```

Mark a notification as read:
```sql
UPDATE notifications
SET    is_read = TRUE
WHERE  id = 'd146095a-0d86-4a34-9e69-3900a14576bc'
  AND  student_id = 1042;
```

Get unread count per student:
```sql
SELECT COUNT(*) AS unread_count
FROM   notifications
WHERE  student_id = 1042
  AND  is_read = FALSE;
```

---

## Stage 3

### Query Analysis & Optimization

#### Is the original query correct? Why is it slow?

```sql
SELECT * FROM notifications
WHERE studentID = 1042 AND isRead = false
ORDER BY createdAt DESC;
```

The query is **logically correct** but slow for two reasons:

1. **No compound index** on `(studentID, isRead)` (or `(studentID, isRead, createdAt)`). PostgreSQL performs a sequential scan of all 5 million rows, filters in memory, then sorts — O(n) I/O regardless of how few rows match.
2. **`SELECT *`** fetches every column including any large `TEXT` fields, inflating network and memory costs unnecessarily.

#### Optimised version

```sql
SELECT id, notification_type, message, created_at
FROM   notifications
WHERE  student_id = 1042
  AND  is_read = FALSE
ORDER  BY created_at DESC;
```

And the index:

```sql
CREATE INDEX idx_notifications_student_unread
  ON notifications (student_id, is_read, created_at DESC)
  WHERE is_read = FALSE;
```

The **partial index** (`WHERE is_read = FALSE`) covers only unread rows — typically a small fraction of the table — keeping the index small and writes fast. With this index the query becomes an **index scan** returning O(k) rows where k is the student's unread count, at essentially constant cost.

#### Adding an index on every column — is it good advice?

No. Each index is a separate B-tree structure maintained on every `INSERT`, `UPDATE`, and `DELETE`. Indexing every column would:

- **Multiply write overhead** — inserting a new notification would update every index.
- **Inflate storage** — a table with 5M rows and 10 indexes can easily use 5× the raw table storage.
- **Confuse the query planner** — with many candidate indexes the planner spends more time choosing and may still pick the wrong one.

Only index columns that appear in `WHERE`, `ORDER BY`, or `JOIN` clauses in high-frequency queries.

#### Query: students who received a Placement notification in the last 7 days

```sql
SELECT DISTINCT s.student_id, s.name, s.email
FROM   notifications n
JOIN   students s ON s.id = n.student_id
WHERE  n.notification_type = 'Placement'
  AND  n.created_at >= NOW() - INTERVAL '7 days';
```

Supporting index:
```sql
CREATE INDEX idx_notifications_type_created
  ON notifications (notification_type, created_at DESC);
```

---

## Stage 4

### Performance & Caching

#### Problem

Every page load triggers a fresh DB query per student. At 50,000 concurrent students this saturates the database.

#### Strategy 1 — Redis Cache

Cache each student's notification list in Redis with a short TTL.

```
Cache key:   notifications:{studentID}:page:{page}
TTL:         30 seconds
Invalidation: on PATCH /:id/read or POST /bulk, delete the student's cache key
```

**Tradeoffs**
- Reads become O(1) for cached students — drastically reduces DB load.
- Stale window: up to 30 s a student may see a slightly outdated count.
- Adds operational complexity (Redis cluster, eviction policy tuning).
- Cache stampede risk on cold-start: use probabilistic early expiry or a mutex lock.

#### Strategy 2 — Pagination

Never return all 5M notifications at once. Enforce a `LIMIT`/`OFFSET` (or cursor-based) pagination.

**Tradeoffs**
- Reduces data transfer and memory pressure on every request.
- Cursor-based pagination (`WHERE created_at < :cursor`) avoids the performance cliff of large `OFFSET` values.
- Slightly more complex client-side scroll/load-more logic.

#### Strategy 3 — Push over Poll (WebSocket / SSE)

Replace polling with server-pushed updates (designed in Stage 1). The client only refreshes on an incoming push frame.

**Tradeoffs**
- Eliminates the majority of read traffic (no repeated GET on idle pages).
- Requires persistent connections — memory cost proportional to concurrent users.
- Need reconnection logic on the client for dropped connections.

#### Strategy 4 — Read Replica

Route all `SELECT` queries to a PostgreSQL read replica; only writes hit the primary.

**Tradeoffs**
- Nearly doubles read throughput with no application-layer changes.
- Replication lag (typically < 100 ms) means a student might momentarily see a stale unread count.

#### Recommended combination

Redis cache (30 s TTL) + pagination + WebSocket push invalidates the cache on new notifications. Read replica is added once the primary starts showing >70% utilisation.

---

## Stage 5

### Reliability & Bulk Notifications

#### Shortcomings of the proposed implementation

```
function notify_all(student_ids: array, message: string):
    for student_id in student_ids:
        send_email(student_id, message)
        save_to_db(student_id, message)
        push_to_app(student_id, message)
```

1. **Sequential loop** — processing 50,000 students one-by-one takes too long (minutes to hours depending on email API latency).
2. **No atomicity** — if `send_email` succeeds but `save_to_db` fails, the student gets an email but no in-app notification, and the notification is invisible to any later query.
3. **No retry** — a transient email API failure drops the notification permanently.
4. **No idempotency** — re-running after a partial failure re-sends to students who already received it.
5. **Memory** — loading all 50,000 IDs in one array can exhaust application memory.

#### What happens when `send_email` fails for 200 students midway?

With the current design: those 200 students never receive an email and there is no record of the failure. The only recovery is a full re-send (which would duplicate notifications for the ~49,800 who succeeded).

#### Redesigned approach

Use a **message queue** (e.g. RabbitMQ, SQS, Kafka) with the **Outbox pattern**:

1. Save the notification to DB first (source of truth) — this is the atomic write.
2. Publish a `notification.created` event to the queue.
3. Two independent workers consume the queue:
   - **Email worker** — calls the email API; retries with exponential backoff; pushes to a dead-letter queue after N failures.
   - **Push worker** — broadcasts via WebSocket/SSE.

This separates the DB write from the email side-effect. A failed email never rolls back the DB record, and retry is handled at the queue level without duplicating the DB insert.

#### Should saving to DB and sending email happen together?

**No.** They should be decoupled:

- The DB insert is the canonical event — it must succeed first.
- Email delivery is a downstream effect that can fail and retry without corrupting state.
- Coupling them in a single transaction blocks the loop on external I/O and makes partial failure unrecoverable.

#### Revised pseudocode

```
function notify_all(student_ids: array, message: string, job_id: string):
    chunks = split(student_ids, chunk_size = 1000)
    for chunk in chunks:
        enqueue(notification_job_queue, {
            job_id,
            student_ids: chunk,
            message,
            idempotency_key: hash(job_id + chunk[0])
        })

# Worker — runs in N parallel processes
function process_notification_job_queue():
    while job = dequeue(notification_job_queue):
        for student_id in job.student_ids:
            if already_processed(job.idempotency_key, student_id):
                continue  # skip duplicates

            db_record = save_to_db(student_id, job.message)  # atomic, first
            push_to_app(student_id, job.message)              # real-time push
            enqueue(email_queue, {                            # async side-effect
                student_id,
                message: job.message,
                notification_id: db_record.id,
                retries: 0
            })
            mark_processed(job.idempotency_key, student_id)

# Email worker — separate process
function process_email_queue():
    while task = dequeue(email_queue):
        try:
            send_email(task.student_id, task.message)
        catch transient_error:
            if task.retries < MAX_RETRIES:
                delay = exponential_backoff(task.retries)
                enqueue_delayed(email_queue, { ...task, retries: task.retries + 1 }, delay)
            else:
                enqueue(dead_letter_queue, task)
                alert_oncall("Email delivery permanently failed", task)
```

---

## Stage 6

### Priority Inbox

#### Approach

Priority is computed as a composite score:

```
score = typeWeight × (1 + 1 / (minutesSinceNotification + 1))
```

Where:
- `typeWeight`: Placement = 3, Result = 2, Event = 1
- The recency term `1 / (minutesSince + 1)` asymptotes toward 0 for old notifications and toward 1 for fresh ones, so within the same type, newer notifications score higher.

This means:
- A fresh Placement always outscores any Result.
- A fresh Result outscores an older Result.
- An hour-old Placement still outscores any Event.

#### Efficient Maintenance as New Notifications Arrive

A **min-heap of fixed size N** is maintained:

1. For each incoming notification, compute its score.
2. If the heap has fewer than N items, push unconditionally.
3. Otherwise, compare against the heap minimum (cheapest `O(1)` peek):
   - If the new score is higher, pop the minimum and push the new notification.
   - Otherwise, discard.
4. At any point, the heap contains exactly the top-N notifications.

**Complexity**: O(log N) per notification, O(N) space — constant regardless of total notification volume.

The implementation lives in `notification_app_be/src/services/priorityInbox.ts` and is exposed via:

```
GET /api/v1/notifications/priority?n=10
```

See the code file for the complete `MinHeap` class and `getTopNPriority` function.
