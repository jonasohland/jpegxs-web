// Status messages from a worker to the page, batched and sent at most every
// 100 ms.
let pendingStatus = null;
let statusTimer = 0;

export function setStatus(type, message) {
  (pendingStatus ??= {})[type] = message;
  statusTimer ||= setTimeout(flushStatus, 100);
}

export function flushStatus() {
  clearTimeout(statusTimer);
  statusTimer = 0;
  if (pendingStatus) self.postMessage({ status: pendingStatus });
  pendingStatus = null;
}

/** Runs `main(message.data)` for the first message; reports errors and completion. */
export function runOnce(main) {
  self.addEventListener(
    "message",
    (message) => {
      main(message.data)
        .then((result) => {
          flushStatus();
          self.postMessage({ done: true, result });
        })
        .catch((e) => {
          console.error(e);
          setStatus("error", String(e?.message ?? e));
          flushStatus();
          self.postMessage({ done: true, error: true });
        });
    },
    { once: true },
  );
}
