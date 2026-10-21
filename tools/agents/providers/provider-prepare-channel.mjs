// A once-only IPC listener is removed before its async work finishes. Keep the
// channel referenced until the worker disconnects after publishing its response.
export function retainPreparationChannel() {
  process.channel?.ref();
}
