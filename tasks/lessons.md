# Lessons (lectern)

## 2026-10-17: retry from `finally` without a delay is a CPU loop

- What went wrong: both audio players refetched a failed chunk at once from the fetch's
  `finally`. When failures are immediate (an engine that is down, a document Chrome is
  closing), that is an unbounded promise loop. In the offscreen player it pinned the
  extension process at 100% CPU, so the closing document never closed and every new
  `createDocument` hung.
- Why it hid: e2e runs with a live engine and cached audio, so nothing failed and nothing
  was in flight when a player closed.
- Rule: every client retry gets a delay (here 2 s per entry, `retryAt`). Look for retries in
  `finally`/`catch` paths whenever a loop of failures is possible.

## 2026-10-17: an e2e check can pass on old code through a side door

- What went wrong: the "closed player is rebuilt" check passed on the old extension because
  a click-to-jump seek still in flight rehydrated the player.
- Rule: run a new check red against the old code first (already in the lesson index), and
  wait for earlier actions to settle before the action under test.
