-- CreateTable
CREATE TABLE "RepoSettings" (
    "repoFullName" TEXT NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT false,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepoSettings_pkey" PRIMARY KEY ("repoFullName")
);
