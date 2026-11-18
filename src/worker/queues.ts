export const QUEUES = {
  heartbeat: "system.heartbeat",
  purgeExpired: "maintenance.purge-expired",
  sweepRecognition: "maintenance.sweep-recognition",
  recognition: "recognition.screenshot",
  analysis: "analysis.run",
  sweepAnalysis: "maintenance.sweep-analysis",
  sweepDeleting: "maintenance.sweep-deleting",
} as const;
