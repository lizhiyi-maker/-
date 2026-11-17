-- CreateEnum
CREATE TYPE "SourceKind" AS ENUM ('TEXT', 'SCREENSHOT');

-- CreateEnum
CREATE TYPE "DataKind" AS ENUM ('CONTINUOUS', 'CURATED', 'UNCERTAIN');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('UPLOADING', 'RECOGNIZING', 'PENDING_CONFIRM', 'CONFIRMED');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('TEXT', 'IMAGE', 'VOICE', 'SYSTEM', 'OTHER');

-- CreateEnum
CREATE TYPE "TimePrecision" AS ENUM ('SECOND', 'MINUTE', 'DATE', 'ORDER_ONLY', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Speaker" AS ENUM ('SELF', 'OTHER', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "RecognitionStatus" AS ENUM ('RECOGNIZED', 'UNCERTAIN', 'USER_EDITED');

-- CreateEnum
CREATE TYPE "MessageState" AS ENUM ('STAGED', 'CONFIRMED');

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "sourceKind" "SourceKind" NOT NULL,
    "dataKind" "DataKind" NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'UPLOADING',
    "parserId" TEXT,
    "labelRoles" JSONB NOT NULL DEFAULT '{}',
    "identityConfirmedAt" TIMESTAMP(3),
    "generation" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "speaker" "Speaker" NOT NULL DEFAULT 'UNKNOWN',
    "speakerLabel" TEXT,
    "type" "MessageType" NOT NULL DEFAULT 'TEXT',
    "occurredAt" TIMESTAMP(3),
    "timePrecision" "TimePrecision" NOT NULL DEFAULT 'UNKNOWN',
    "origin" JSONB NOT NULL,
    "recognition" "RecognitionStatus" NOT NULL DEFAULT 'RECOGNIZED',
    "uncertainReason" TEXT,
    "state" "MessageState" NOT NULL DEFAULT 'STAGED',
    "duplicateOfId" TEXT,
    "currentRevision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageRevision" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportBatch_personId_status_idx" ON "ImportBatch"("personId", "status");

-- CreateIndex
CREATE INDEX "ImportBatch_userId_status_idx" ON "ImportBatch"("userId", "status");

-- CreateIndex
CREATE INDEX "Message_personId_state_idx" ON "Message"("personId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Message_batchId_seq_key" ON "Message"("batchId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "MessageRevision_messageId_revision_key" ON "MessageRevision"("messageId", "revision");

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportBatch" ADD CONSTRAINT "ImportBatch_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "ImportBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageRevision" ADD CONSTRAINT "MessageRevision_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

