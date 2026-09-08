import { createConnection } from "node:net";
import { randomInt } from "node:crypto";
import { operationSignal } from "./http.js";

export async function mpvCommand(path: string, command: unknown[], timeoutMs = 1500, signal = operationSignal()): Promise<unknown> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const id = randomInt(1, 0x7fffffff);
    const socket = createConnection(path);
    let buffer = "", settled = false;
    const finish = (error?: Error, data?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error); else resolve(data);
    };
    const abort = () => finish(new Error("Player control cancelled"));
    const timer = setTimeout(() => finish(new Error("mpv IPC timed out")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ command, request_id: id }) + "\n"));
    socket.on("error", (e) => finish(e));
    socket.on("close", () => finish(new Error("mpv IPC disconnected before acknowledgement")));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { finish(new Error("mpv IPC response too large")); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (message.request_id !== id) continue;
          finish(message.error === "success" ? undefined : new Error(`mpv: ${message.error ?? "invalid response"}`), message.data);
        } catch { finish(new Error("Malformed mpv IPC response")); }
      }
    });
  });
}
