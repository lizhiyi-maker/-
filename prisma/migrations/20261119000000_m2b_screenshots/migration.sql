-- CreateEnum
CREATE TYPE "ScreenshotStatus" AS ENUM ('UPLOADED', 'QUEUED', 'RUNNING', 'DONE', 'FAILED', 'SKIPPED');

-- AlterTable
ALTER TABLE "ImportBatch" ADD COLUMN     "recRound" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Screenshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "idx" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "ScreenshotStatus" NOT NULL DEFAULT 'UPLOADED',
    "round" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "queuedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),

    CONSTRAINT "Screenshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Screenshot_storageKey_key" ON "Screenshot"("storageKey");

-- CreateIndex
CREATE INDEX "Screenshot_personId_sha256_idx" ON "Screenshot"("personId", "sha256");

-- CreateIndex
CREATE INDEX "Screenshot_batchId_status_idx" ON "Screenshot"("batchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Screenshot_batchId_idx_key" ON "Screenshot"("batchId", "idx");

-- AddForeignKey
ALTER TABLE "Screenshot" ADD CONSTRAINT "Screenshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Screenshot" ADD CONSTRAINT "Screenshot_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Screenshot" ADD CONSTRAINT "Screenshot_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

