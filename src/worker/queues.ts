export const QUEUES = {
  heartbeat: "system.heartbeat",
  purgeExpired: "maintenance.purge-expired",
  sweepRecognition: "maintenance.sweep-recognition",
  recognition: "recognition.screenshot",
} as const;
