-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'INVALIDATED');

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "providerId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Analysis" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "generation" INTEGER NOT NULL,
    "snapshotAt" TIMESTAMP(3) NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "snapshotRefs" JSONB NOT NULL,
    "preferenceVersion" INTEGER NOT NULL,
    "preferenceValues" JSONB NOT NULL,
    "rulesVersion" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "output" JSONB,
    "meta" JSONB,
    "explicitRefusal" BOOLEAN NOT NULL DEFAULT false,
    "errorCode" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Analysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConsentRecord_userId_version_providerId_key" ON "ConsentRecord"("userId", "version", "providerId");

-- CreateIndex
CREATE INDEX "Analysis_personId_status_finishedAt_idx" ON "Analysis"("personId", "status", "finishedAt");

-- CreateIndex
CREATE INDEX "Analysis_userId_status_idx" ON "Analysis"("userId", "status");

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

