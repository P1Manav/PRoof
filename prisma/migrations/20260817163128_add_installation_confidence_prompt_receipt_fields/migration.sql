-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "commenter" TEXT,
ADD COLUMN     "source" TEXT;

-- CreateTable
CREATE TABLE "Installation" (
    "id" INTEGER NOT NULL,
    "appId" INTEGER NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "repos" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfidencePrompt" (
    "id" TEXT NOT NULL,
    "repoFullName" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "commentId" BIGINT NOT NULL,
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConfidencePrompt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConfidencePrompt_repoFullName_prNumber_key" ON "ConfidencePrompt"("repoFullName", "prNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_repoFullName_prNumber_userId_key" ON "Receipt"("repoFullName", "prNumber", "userId");
