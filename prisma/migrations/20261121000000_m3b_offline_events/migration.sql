-- CreateEnum
CREATE TYPE "EventKind" AS ENUM ('MEET', 'CALL', 'CANCELLED', 'FACT_NOTE');

-- AlterTable
ALTER TABLE "Analysis" ADD COLUMN     "eventCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "eventRefs" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "OfflineEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "kind" "EventKind" NOT NULL,
    "occurredOn" DATE NOT NULL,
    "currentRevision" INTEGER NOT NULL DEFAULT 1,
    "personalNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfflineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineEventRevision" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" "EventKind" NOT NULL,
    "occurredOn" DATE NOT NULL,
    "facts" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineEventRevision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OfflineEvent_personId_occurredOn_idx" ON "OfflineEvent"("personId", "occurredOn");

-- CreateIndex
CREATE UNIQUE INDEX "OfflineEventRevision_eventId_revision_key" ON "OfflineEventRevision"("eventId", "revision");

-- AddForeignKey
ALTER TABLE "OfflineEvent" ADD CONSTRAINT "OfflineEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineEvent" ADD CONSTRAINT "OfflineEvent_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineEventRevision" ADD CONSTRAINT "OfflineEventRevision_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "OfflineEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

