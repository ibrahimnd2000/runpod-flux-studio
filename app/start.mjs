// Container entrypoint. Runpod mounts the pod volume (/workspace) owned by root,
// so start as root just long enough to create DATA_DIR for the `node` user,
// then drop privileges before the app is loaded.
import { chownSync, mkdirSync } from "node:fs";

const NODE_UID = 1000; // `node` user in the official image

if (process.getuid?.() === 0) {
  const dir = process.env.DATA_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    chownSync(dir, NODE_UID, NODE_UID);
  }
  process.setgid(NODE_UID);
  process.setuid(NODE_UID);
}

await import("./server.js");
