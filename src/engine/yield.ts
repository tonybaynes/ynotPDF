/**
 * Yields to the event loop as a macrotask without the timer clamp (M10). The worker uses it
 * between queued requests and inside progressive renders so `cancel` messages — which arrive as
 * macrotasks — are seen promptly even when every individual render is short.
 */

export function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'function') {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    } else {
      setTimeout(resolve, 0);
    }
  });
}
